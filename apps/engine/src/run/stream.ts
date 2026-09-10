/**
 * Turning a byte stream into redacted lines, WITHOUT ever emitting half a
 * secret.
 *
 * THE HARD CASE IS A SECRET SPLIT ACROSS TWO CHUNKS. A stream hands us
 * arbitrary slices — `"ABCD"` then `"EFGH\n"` — and the naive fix (scrub each
 * slice as it arrives) is actively worse than doing nothing when secrets share a
 * prefix: with `ABCD` and `ABCDEFGH` both marked secret, scrubbing the first
 * slice turns it into «redacted» and the second slice then sails past as a bare
 * `EFGH`, which is the tail of the longer secret, published. The rule this
 * module follows instead is: TEXT IS ONLY EMITTED ONCE NO LATER BYTE COULD
 * CHANGE HOW IT IS REDACTED.
 *
 * That gives two kinds of emission:
 *
 *   - A COMPLETE LINE is always safe. A secret may not contain a line break
 *     (`RunEnvVar` refuses one, precisely so this holds), so nothing arriving
 *     after the `\n` can be part of a secret that started before it.
 *   - A FORCED FLUSH — for a process that writes a megabyte with no newline at
 *     all — cuts at a point that is inside no secret (`safeCut`) and leaves the
 *     last `longest - 1` characters unemitted, since a secret could still be
 *     half-arrived there.
 *
 * The carry is kept RAW for exactly that reason. Scrubbing it early would
 * destroy the evidence needed to recognise the longer match later.
 */
import { redactText } from "./types";

/**
 * The first index at or after `at` that does not fall inside an occurrence of a
 * secret. Cutting there means neither side of the cut holds a fragment of a
 * value we promised to hide.
 */
export function safeCut(text: string, secrets: readonly string[], at: number): number {
  let cut = Math.min(at, text.length);
  // A pushed cut can land inside a DIFFERENT secret, so this settles rather than
  // passing once. `cut` only ever grows and is bounded by the text, so it ends.
  for (let moved = true; moved; ) {
    moved = false;
    for (const secret of secrets) {
      if (!secret) continue;
      for (let index = text.indexOf(secret); index !== -1 && index < cut; index = text.indexOf(secret, index + 1)) {
        if (index + secret.length > cut) {
          cut = index + secret.length;
          moved = true;
        }
      }
    }
  }
  return cut;
}

export type OutputSplitter = {
  /** Feed one arbitrary slice of the stream. */
  push(chunk: string): void;
  /** The stream ended: whatever is left is complete, so it can be emitted. */
  end(): void;
};

/**
 * Split a stream into redacted lines, bounding how much is held for a process
 * that never sends a newline.
 *
 * `emit` receives text that has already been scrubbed.
 */
export function createOutputSplitter(secrets: readonly string[], maxLineChars: number, emit: (text: string) => void): OutputSplitter {
  const longest = secrets.reduce((length, secret) => Math.max(length, secret.length), 0);
  /** How much tail must stay unemitted: a secret one character short of complete. */
  const hold = Math.max(0, longest - 1);
  let carry = "";

  /**
   * Emit one complete line, WRAPPED rather than truncated.
   *
   * A line longer than the cap used to depend on how the OS happened to slice
   * the stream: arriving in pieces it was flushed as several bounded lines, and
   * arriving in one chunk with its newline attached it became a single line that
   * the caller then cut to the cap — silently dropping the rest. Same bytes,
   * different output. Wrapping here makes the result a function of the text
   * alone, and each piece is cut where no secret straddles it.
   */
  const line = (text: string) => {
    let rest = text.replace(/\r$/, "");
    while (rest.length > maxLineChars) {
      const cut = safeCut(rest, secrets, maxLineChars);
      // The only cut available is the end of the text: a secret straddles the
      // cap and moving past it consumes the rest. Emit it whole rather than
      // loop, and rather than add an empty line after it.
      if (cut >= rest.length) break;
      emit(redactText(rest.slice(0, cut), secrets));
      rest = rest.slice(cut);
    }
    emit(redactText(rest, secrets));
  };

  return {
    push(chunk: string): void {
      carry += chunk;
      const parts = carry.split("\n");
      carry = parts.pop() ?? "";
      for (const part of parts) line(part);

      while (carry.length - hold >= maxLineChars) {
        const cut = safeCut(carry, secrets, maxLineChars);
        // The cut had to move past the end of the settled region to avoid
        // splitting a secret: hold everything and wait for the next chunk.
        if (cut > carry.length - hold) break;
        line(carry.slice(0, cut));
        carry = carry.slice(cut);
      }
    },
    end(): void {
      if (carry) line(carry);
      carry = "";
    },
  };
}
