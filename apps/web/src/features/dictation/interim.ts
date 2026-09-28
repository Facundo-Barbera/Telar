import type { ComposerWrite } from "@/features/composer";
import type { DictationWords } from "./transcript";

export type DictationBox = {
  draft: () => string;
  insert: (text: string) => ComposerWrite;
  replace: (start: number, end: number, text: string) => ComposerWrite;
  dictating?: (state: { listening: boolean; interim?: { start: number; end: number } }) => void;
  caretRect?: () => DOMRect | undefined;
};

export type DictationWriter = {
  /** Returns the composer's refusal when it turned the write away. */
  write: (words: DictationWords) => ComposerWrite | undefined;
  /** The unconfirmed run, or `undefined` between utterances and after someone else typed. */
  span: () => { start: number; end: number } | undefined;
  /** Forget the span without touching the draft. Call when a dictation ends. */
  forget: () => void;
};

/**
 * `insert` adds surrounding spacing, so the changed run is wider than `text`; the
 * span must exclude that spacing or a revision would join two words. Falls back
 * to the whole changed run if the composer transformed the text.
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
  let span: { start: number; end: number } | undefined;
  let committed: string | undefined;

  const forget = (): void => {
    span = undefined;
    committed = undefined;
  };

  return {
    forget,
    span: () => span,
    write(words) {
      // Someone else edited the draft, so the offsets are stale; the next guess
      // opens a fresh span at the caret.
      if (span !== undefined && box.draft() !== committed) span = undefined;

      if (span === undefined) {
        if (!words.text) return undefined;
        const before = box.draft();
        const written = box.insert(words.text);
        if (!written.ok) {
          forget();
          return written;
        }
        committed = written.draft;
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
