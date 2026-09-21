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
const SHORT_COLON_TRUECOLOUR = /\x1b\[([0-9;:]*?)([345]8):2:(\d+):(\d+):(\d+)(?=[;m])/g;

export function normaliseTruecolourSgr(data: string): string {
  if (!data.includes(":2:")) return data;
  return data.replace(SHORT_COLON_TRUECOLOUR, (_all, before: string, kind: string, r: string, g: string, b: string) => `\u001b[${before}${kind}:2::${r}:${g}:${b}`);
}

/**
 * A CSI sequence can straddle two PTY chunks, and a rewrite that only sees
 * half of one would leave that colour wrong. This holds back a trailing CSI
 * that has no final byte yet and prepends it to the next chunk. Anything that
 * is not an unfinished `ESC [` goes through as it arrived.
 */
export function splitTrailingCsi(data: string): { ready: string; pending: string } {
  const esc = data.lastIndexOf("\u001b");
  if (esc === -1) return { ready: data, pending: "" };
  const tail = data.slice(esc);
  // `ESC` alone, or `ESC [` followed only by parameter/intermediate bytes.
  if (tail === "\x1b" || /^\x1b\[[0-9;:?<=>!]*$/.test(tail)) return { ready: data.slice(0, esc), pending: tail };
  return { ready: data, pending: "" };
}

/**
 * THE KEY ITERM2 TREATS AS OPTIONAL AND @xterm/addon-image TREATS AS REQUIRED.
 *
 * An iTerm inline image is `OSC 1337 ; File = k=v;k=v : <base64> BEL`. iTerm2
 * documents `size=` as the payload's byte count and draws the image without it;
 * fastfetch (`--logo-type iterm`) never sends it. addon-image 0.9.0 aborts the
 * whole sequence when `size` is absent — its decoder is sized from the header —
 * so the logo's cells are reserved (fastfetch moves the cursor past them) and
 * nothing is drawn in them. Measured on the live terminal: the identical bytes
 * with `size=` inserted store and place the image.
 *
 * The size is not known until the payload has all arrived, so an image header
 * without it holds the sequence back until its terminator and then lets it
 * through with the count filled in. A header that already carries `size=` is
 * not touched. A sequence that grows past the addon's own limit is released
 * as it came, because at that point the addon would refuse it anyway.
 */
const IIP_HEADER = "\u001b]1337;File=";
const IIP_HOLD_LIMIT = 20_000_000 * 1.4; // addon's iipSizeLimit, as base64

function base64ByteLength(payload: string): number {
  const clean = payload.replace(/[\s=]/g, "");
  return Math.floor((clean.length * 3) / 4);
}

function iipTerminator(text: string, from: number): { at: number; length: number } | undefined {
  const bel = text.indexOf("\u0007", from);
  const st = text.indexOf("\u001b\\", from);
  if (bel === -1 && st === -1) return undefined;
  if (st === -1 || (bel !== -1 && bel < st)) return { at: bel, length: 1 };
  return { at: st, length: 2 };
}

export function iipSizeFiller(): (data: string) => string {
  let held = "";
  const complete = (sequence: string, end: { at: number; length: number }): string => {
    const colon = sequence.indexOf(":");
    const header = colon === -1 ? sequence.slice(0, end.at) : sequence.slice(0, colon);
    if (colon === -1 || /(^|;)size=/.test(header.slice(IIP_HEADER.length))) return sequence;
    const size = base64ByteLength(sequence.slice(colon + 1, end.at));
    return `${IIP_HEADER}size=${size};${sequence.slice(IIP_HEADER.length)}`;
  };
  return function fill(data: string): string {
    if (held !== "") {
      held += data;
      const end = iipTerminator(held, IIP_HEADER.length);
      if (end === undefined) {
        if (held.length <= IIP_HOLD_LIMIT) return "";
        const out = held;
        held = "";
        return out;
      }
      const stop = end.at + end.length;
      const done = complete(held.slice(0, stop), end);
      const rest = held.slice(stop);
      held = "";
      return done + fill(rest);
    }
    const start = data.indexOf(IIP_HEADER);
    if (start === -1) return data;
    held = data.slice(start);
    return data.slice(0, start) + fill("");
  };
}

/**
 * EVERY BYTE FROM A PTY GOES THROUGH THIS, WHICHEVER SURFACE OWNS THE PTY.
 *
 * The three corrections above (short colon truecolour, a CSI split across
 * chunks, an inline image without `size=`) are properties of xterm.js and of
 * the programs that write to a PTY, not of the Terminal tab. A Run tab reads
 * the same kind of bytes from the engine's journal and draws them with the
 * same emulator, so it takes the same writer; a second copy of the pipeline
 * in run-terminal.tsx is how the two tabs would drift.
 */
export function ptyByteWriter(term: Pick<TerminalLike, "write">): (data: string) => void {
  let pending = "";
  const fillImageSize = iipSizeFiller();
  return (data) => {
    const split = splitTrailingCsi(pending + fillImageSize(data));
    pending = split.pending;
    if (split.ready !== "") term.write(normaliseTruecolourSgr(split.ready));
  };
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
  const writeBytes = ptyByteWriter(term);
  const offData = bridge.onData((chunk) => {
    if (chunk.id === id) writeBytes(chunk.data);
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
