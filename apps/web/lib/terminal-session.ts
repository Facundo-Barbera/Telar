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
  const offData = bridge.onData((chunk) => {
    if (chunk.id === id) term.write(chunk.data);
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
