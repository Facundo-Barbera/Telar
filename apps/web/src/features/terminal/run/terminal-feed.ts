import type { RunBytesAnswer } from "./types";

/** The most of a run's window replayed onto an empty screen; the engine keeps up to 256 KB. */
export const REPLAY_CHARS = 128_000;

export type RunByteFeed = {
  /** Clear the emulator before writing: a different stream, or a gap. */
  reset: boolean;
  /** What to write, in order, as separate items: xterm yields only between them. */
  chunks: readonly string[];
  /** Where the next poll resumes from. */
  cursor: number;
  /** Chunks at the head of a replay left unwritten to keep it within `REPLAY_CHARS`. */
  skipped: number;
};

/** The newest chunks that fit in `limit` characters, always at least the last one. */
export function replayTail(chunks: readonly string[], limit = REPLAY_CHARS): { chunks: readonly string[]; skipped: number } {
  let start = chunks.length;
  let size = 0;
  while (start > 0 && size + chunks[start - 1]!.length <= limit) size += chunks[--start]!.length;
  if (start === chunks.length && start > 0) start -= 1;
  return { chunks: start === 0 ? chunks : chunks.slice(start), skipped: start };
}

/** What a terminal should do with one `/run/bytes` answer, given where it was. A cursor that went back or a ring that dropped past us is a different stream. */
export function byteFeed(previous: number, answer: RunBytesAnswer): RunByteFeed {
  const reset = answer.cursor < previous || answer.dropped > previous;
  const replay = reset || previous === 0 ? replayTail(answer.chunks) : { chunks: answer.chunks, skipped: 0 };
  return { reset, chunks: replay.chunks, cursor: answer.cursor, skipped: replay.skipped };
}

/** What to say above a terminal whose earlier output is not on screen, so the gap is visible. */
export function byteDroppedNotice(dropped: number): string | undefined {
  if (!dropped) return undefined;
  return "Earlier output is no longer kept.";
}
