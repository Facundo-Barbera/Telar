/**
 * ONE EMULATOR, ONE PTY, AND THE BYTES BETWEEN THEM (#198).
 *
 * Split out of the surface so that the part with the actual protocol in it can
 * be exercised without a rendered terminal. That is not a testing nicety — it
 * is the only way to check the thing that matters. A test that mounts the
 * surface and looks for text on screen passes when the emulator ignored every
 * escape sequence it was sent, because the TEXT is there either way; a test
 * that pushes bytes through this and reads the buffer's cell ATTRIBUTES back
 * cannot. Likewise for keys: "a handler ran" is satisfied by the exact bug —
 * a handler that fires and swallows the byte — so what is asserted is the byte
 * arriving at the host.
 *
 * The surface keeps what genuinely needs a document: the element, the addons,
 * the size, and the lifecycle.
 */
import { ptyBytesForKey, type TerminalKeyEvent } from "@/lib/terminal-keys";
import type { TerminalBridge, TerminalEnding } from "@/lib/terminal-bridge";

/** As much of xterm's `Terminal` as the wiring touches. Structural so a test
 *  can use the real one — the point is that it IS the real one — without this
 *  module importing the emulator. */
export type TerminalLike = {
  write: (data: string) => void;
  onData: (listener: (data: string) => void) => { dispose: () => void };
};

/**
 * THE ONE SEQUENCE XTERM.JS 6 GETS WRONG, AND WHAT NEOVIM 0.12 EMITS.
 *
 * ISO 8613-6 spells a truecolour SGR as `38:2::R:G:B` — the empty slot is the
 * colour-space id. Neovim (from 0.10, on any `TERM` whose terminfo it trusts)
 * writes the SHORT form `38:2:R:G:B` with no slot. xterm.js reads the short
 * form as if the slot were there, so `38:2:120:126:147` lands as R=126,
 * G=147, B=(missing → 0): every colour loses its red and gains a green cast,
 * which is exactly the all-olive Neovim the owner photographed. Measured on
 * @xterm/xterm 6.0.0 by writing the three forms into a buffer and reading the
 * cell back: semicolons and the five-subparam colon form both give `787e93`;
 * the four-subparam form gives `7e9300`.
 *
 * Rewritten here, at the byte level, before the parser sees it — because this
 * function is the ONLY place PTY bytes enter the emulator, and a CSI handler
 * registered on top of xterm's own would have to re-implement the whole of
 * SGR to be able to say "handled". Only SGR 38/48/58 with a `:2:` selector
 * and exactly three following subparams is touched; the five-subparam form,
 * semicolons, and every other sequence pass through untouched.
 */
const SHORT_COLON_TRUECOLOUR = /\[([0-9;:]*?)([345]8):2:(\d+):(\d+):(\d+)(?=[;m])/g;

export function normaliseTruecolourSgr(data: string): string {
  if (!data.includes(":2:")) return data;
  return data.replace(SHORT_COLON_TRUECOLOUR, (_all, before: string, kind: string, r: string, g: string, b: string) => `[${before}${kind}:2::${r}:${g}:${b}`);
}

/**
 * A CSI sequence can straddle two PTY chunks, and a rewrite that only sees
 * half of one would leave that colour wrong. This holds back a trailing CSI
 * that has no final byte yet and prepends it to the next chunk. Anything that
 * is not an unfinished `ESC [` goes through as it arrived.
 */
export function splitTrailingCsi(data: string): { ready: string; pending: string } {
  const esc = data.lastIndexOf("");
  if (esc === -1) return { ready: data, pending: "" };
  const tail = data.slice(esc);
  // `ESC` alone, or `ESC [` followed only by parameter/intermediate bytes.
  if (tail === "" || /^\[[0-9;:?<=>!]*$/.test(tail)) return { ready: data.slice(0, esc), pending: tail };
  return { ready: data, pending: "" };
}

/**
 * Connect an emulator to a terminal the host has already opened. Answers the
 * detach, which every caller must hold: the bridge's `onData` is a single
 * channel for EVERY terminal in the window, so a listener that outlives its
 * tab keeps writing another shell's bytes into a disposed buffer.
 */
export function attachTerminal(
  term: TerminalLike,
  bridge: Pick<TerminalBridge, "write" | "onData" | "onExit">,
  id: string,
  onEnd?: (ending: TerminalEnding) => void,
): () => void {
  const offs: Array<() => void> = [];
  offs.push(term.onData((data) => void bridge.write(id, data)).dispose);
  // FILTERED BY ID, both ways. Two terminal tabs share one IPC channel, and an
  // unfiltered listener is how one tab's `ls` ends up drawn in the other's.
  let pending = "";
  const offData = bridge.onData((chunk) => {
    if (chunk.id !== id) return;
    const split = splitTrailingCsi(pending + chunk.data);
    pending = split.pending;
    if (split.ready !== "") term.write(normaliseTruecolourSgr(split.ready));
  });
  if (offData) offs.push(offData);
  const offExit = bridge.onExit((ending) => {
    if (ending.id === id) onEnd?.(ending);
  });
  if (offExit) offs.push(offExit);
  return () => {
    for (const off of offs.splice(0)) off();
  };
}

/** The part of a `KeyboardEvent` the handler needs to be able to cancel. */
export type CancellableKeyEvent = TerminalKeyEvent & {
  type?: string;
  preventDefault?: () => void;
  stopPropagation?: () => void;
};

/**
 * xterm's `attachCustomKeyEventHandler`, for the three keys a focused shell
 * must not lose.
 *
 * RETURNS `false` TO STAND XTERM DOWN, which is what stops the byte being
 * written twice — this writes it, so xterm must not also encode it.
 *
 * `stopPropagation` IS THE LOAD-BEARING CALL. The cockpit's dispatcher listens
 * on `window` at the end of the bubble chain and does not consult
 * `defaultPrevented`, so `preventDefault` alone leaves `^R` running whatever a
 * person has bound it to while their shell waits for a history search.
 */
export function terminalKeyHandler(write: (bytes: string) => void): (event: CancellableKeyEvent) => boolean {
  return (event) => {
    if (event.type !== undefined && event.type !== "keydown") return true;
    const bytes = ptyBytesForKey(event);
    if (bytes === undefined) return true;
    event.preventDefault?.();
    event.stopPropagation?.();
    write(bytes);
    return false;
  };
}
