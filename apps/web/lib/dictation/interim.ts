/**
 * UNCONFIRMED WORDS, IN THE BOX, REPLACED IN PLACE (#544).
 *
 * ── WHAT CHANGED AND WHY ────────────────────────────────────────────────────
 * The first cut showed Deepgram's interim guesses in a caption beside the mic
 * button and only inserted a phrase once it was final. It reads as a lag: you
 * speak, the box stays empty, and a sentence appears a beat after you stopped.
 * The owner asked for the words to go INTO the composer as they are heard and
 * be rewritten in place as Deepgram revises them, which is what every dictation
 * people already use does.
 *
 * ── SO THIS TRACKS ONE SPAN, AND THE SPAN IS FRAGILE ────────────────────────
 * The unconfirmed words occupy a run of the draft — `start..end` in draft
 * offsets — and each new guess replaces that run. When a phrase settles, the
 * span is simply forgotten: the words stay where they are and stop being the
 * dictation's to rewrite, so the next utterance opens a new span after them.
 *
 * THE COMPOSER IS A LIVE BOX AND THE PERSON IS NOT ASKED TO SIT STILL. They can
 * type into the middle of the guess, delete it, paste over it, or move the
 * caret somewhere else entirely. An offset range does not survive any of that,
 * and writing through a stale one would eat text nobody dictated — the exact
 * failure that keeps `replace` off the page API (see `composer-registry.ts`).
 *
 * THE GUARD IS ONE COMPARISON: this writer remembers the draft it last
 * committed, and before every write it asks the box what it holds now. Not
 * equal means somebody else wrote — so the span is DROPPED and the next guess
 * starts a fresh one at the caret, wherever the person has moved to. It is
 * deliberately blunt: nothing here tries to work out whether the edit was
 * inside the span, before it or after it, because all three answers end in the
 * same place and the arithmetic of the other two would be a source of exactly
 * the bug it was written to avoid.
 *
 * ── AND IT IS A PLAIN CLOSURE, NOT A HOOK ───────────────────────────────────
 * It owns no React state — the composer owns the draft — so a test drives it
 * with a fake box that is a string, and every rule in it is checked without a
 * microphone, a socket, or a DOM.
 */

import type { ComposerWrite } from "@/lib/composer-registry";
import type { DictationWords } from "./transcript";

/** The half of the composer registry's entry that a dictation touches. Named
 *  here rather than taking a whole `ComposerEntry` so the fake in the test is
 *  three functions and a string. */
export type DictationBox = {
  draft: () => string;
  insert: (text: string) => ComposerWrite;
  replace: (start: number, end: number, text: string) => ComposerWrite;
};

export type DictationWriter = {
  /** Put this frame's words in the box. Answers the refusal when the composer
   *  turned the write away — the caller's only move is to show it. */
  write: (words: DictationWords) => ComposerWrite | undefined;
  /** Forget the span without touching the draft. Called when a dictation ends:
   *  whatever is in the box is the person's now, and a span remembered across
   *  presses would have the next one rewrite the last one's words. */
  forget: () => void;
};

/**
 * WHERE THE WORDS LANDED, by diffing what the box held against what it
 * committed.
 *
 * The composer's `insert` does not splice at a known offset: it goes in at the
 * caret and adds the spacing a person would have typed (`insertReference`), so
 * the run that appeared is WIDER than the text handed over — " and " for
 * "and". Asking the editor for offsets instead would be a second imperative
 * call and a second thing to keep in step; the two strings already say it.
 *
 * AND THE SPACING IS NOT PART OF THE SPAN, which is the load-bearing half of
 * this: a span that swallowed the leading space would lose it on the first
 * revision and run two words together. So the changed run is found by common
 * prefix and common suffix, and then the TEXT is located inside it. The suffix
 * scan is bounded so the two cannot cross and claim overlapping ground on a
 * draft full of repeated words.
 *
 * THE FALLBACK IS THE WHOLE RUN, for a composer that transformed the text on
 * the way in — a chip, a normalised path. Wider than it needs to be and
 * therefore safe: the next revision replaces something this dictation wrote.
 */
export function insertedSpan(before: string, after: string, text: string): { start: number; end: number } {
  const shortest = Math.min(before.length, after.length);
  let start = 0;
  while (start < shortest && before[start] === after[start]) start += 1;
  let tail = 0;
  while (tail < shortest - start && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail += 1;
  const end = after.length - tail;
  const at = text ? after.indexOf(text, start) : -1;
  return at >= 0 && at + text.length <= end ? { start: at, end: at + text.length } : { start, end };
}

export function createDictationWriter(box: DictationBox): DictationWriter {
  /** The unconfirmed run, in draft offsets. Absent between utterances and
   *  after anybody else has written. */
  let span: { start: number; end: number } | undefined;
  /** The draft this writer last committed. The whole of the "did somebody else
   *  type?" test — see the header. */
  let committed: string | undefined;

  const forget = (): void => {
    span = undefined;
    committed = undefined;
  };

  return {
    forget,
    write(words) {
      // SOMEBODY ELSE WROTE, so the offsets mean nothing now. Dropping the span
      // is the whole recovery: the guess already in the box becomes ordinary
      // text the person can edit, and the next one opens a span at the caret.
      if (span !== undefined && box.draft() !== committed) span = undefined;

      if (span === undefined) {
        // NOTHING TO OPEN A SPAN WITH. An empty interim is Deepgram hearing
        // silence, and an empty final is it settling that silence — writing
        // either into the box would be a spurious space in somebody's message.
        if (!words.text) return undefined;
        const before = box.draft();
        const written = box.insert(words.text);
        if (!written.ok) {
          forget();
          return written;
        }
        committed = written.draft;
        // A FINAL NEVER LEAVES A SPAN BEHIND: the words are the person's now.
        span = words.final ? undefined : insertedSpan(before, written.draft, words.text);
        return written;
      }

      const written = box.replace(span.start, span.end, words.text);
      if (!written.ok) {
        forget();
        return written;
      }
      committed = written.draft;
      span = words.final ? undefined : { start: span.start, end: span.start + words.text.length };
      return written;
    },
  };
}
