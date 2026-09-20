/**
 * A POLL'S ANSWER, TURNED INTO ONE INSTRUCTION FOR AN EMULATOR (#198).
 *
 * Split out of the surface for the same reason `lib/terminal-session.ts` was:
 * the part with the decision in it can then be exercised against a REAL xterm
 * buffer, and a test that mounts a component and looks for text on screen
 * passes when the emulator ignored every escape sequence it was sent.
 *
 * THE DECISION IS "IS THIS THE SAME STREAM I WAS DRAWING". A terminal is
 * stateful in a way a `<pre>` is not: appending bytes from a different run to a
 * buffer that already holds another one does not look wrong, it looks like the
 * first run printed something it never printed. Two things make the answer no,
 * and they are different facts rather than one restated:
 *
 *   - THE CURSOR WENT BACKWARDS. A restart, or a different run in the slot. The
 *     engine's `RunOutputAnswer` has meant this since the line view shipped.
 *   - THE RING DROPPED PAST WHERE WE WERE. The engine keeps a bounded window
 *     and reports what it discarded; once `dropped` is ahead of our cursor, the
 *     chunks it hands back are not contiguous with what we drew. Appending them
 *     would splice a gap into the middle of a screen without saying so.
 *
 * Both answer `reset`, which the surface turns into `term.reset()`. That is
 * honest rather than clever: the scrollback belongs to the program on the other
 * end, and Telar redrawing a guess at it would be Telar inventing output.
 */
import type { RunBytesAnswer } from "./types";

export type RunByteFeed = {
  /** Clear the emulator before writing — a different stream, or a gap. */
  reset: boolean;
  /** What to write, in order. Empty when the answer carried nothing new. */
  text: string;
  /** Where the next poll resumes from. */
  cursor: number;
};

/** What a terminal should do with one `/run/bytes` answer, given where it was. */
export function byteFeed(previous: number, answer: RunBytesAnswer): RunByteFeed {
  const reset = answer.cursor < previous || answer.dropped > previous;
  return {
    reset,
    // CONCATENATED, NOT WRITTEN ONE BY ONE BY THE CALLER. Every chunk left the
    // engine's redactor whole, so no sequence straddles a boundary and joining
    // them is exactly what writing them in order would have produced.
    text: answer.chunks.join(""),
    cursor: answer.cursor,
  };
}

/** What to say above a terminal whose earlier output the engine no longer
 *  keeps, so the gap is visible rather than a silently shorter screen. */
export function byteDroppedNotice(dropped: number): string | undefined {
  if (!dropped) return undefined;
  return "Earlier output is no longer kept.";
}
