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
  /** What to write, in order and ONE AT A TIME. Empty when the answer carried
   *  nothing new. */
  chunks: readonly string[];
  /** Where the next poll resumes from. */
  cursor: number;
};

/** What a terminal should do with one `/run/bytes` answer, given where it was. */
export function byteFeed(previous: number, answer: RunBytesAnswer): RunByteFeed {
  const reset = answer.cursor < previous || answer.dropped > previous;
  return {
    reset,
    /**
     * HANDED OVER AS CHUNKS, AND THAT IS THE WHOLE POINT OF THIS FIELD (#909).
     *
     * They used to be joined here, on the true observation that every chunk
     * left the redactor whole — so the concatenation IS what writing them in
     * order produces, character for character. What it is not is what writing
     * them in order COSTS. xterm's `WriteBuffer` checks its 12 ms budget
     * between write ITEMS and never inside one, so a joined window is one
     * uninterrupted parse on the main thread: the engine keeps up to 4000
     * chunks / 256 KB, and the click queued behind that string waits for all
     * of it. The same bytes as 4000 items yield to the browser 3999 times.
     */
    chunks: answer.chunks,
    cursor: answer.cursor,
  };
}

/** What to say above a terminal whose earlier output the engine no longer
 *  keeps, so the gap is visible rather than a silently shorter screen. */
export function byteDroppedNotice(dropped: number): string | undefined {
  if (!dropped) return undefined;
  return "Earlier output is no longer kept.";
}
