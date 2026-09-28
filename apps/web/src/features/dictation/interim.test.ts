/**
 * The box is a string written through the same helpers the composer uses; the
 * spacing `insertReference` adds is what a naive span swallows.
 */
import { describe, expect, test } from "bun:test";
import { insertReference } from "@/features/composer/drag-reference";
import { replaceTextRange } from "@/features/composer";
import { createDictationWriter, insertedSpan, type DictationBox } from "./interim";

/** A composer that is a string and a caret, using the helpers `composer-editor.tsx` calls. */
function box(initial = "", caretAt = initial.length) {
  let draft = initial;
  let caret = caretAt;
  /** Set to refuse, the way a composer that has unmounted does. */
  let refusal: string | undefined;

  const port: DictationBox = {
    draft: () => draft,
    insert: (text) => {
      if (refusal) return { ok: false, reason: refusal };
      const next = insertReference(draft, text, caret);
      draft = next.draft;
      caret = next.caret;
      return { ok: true, draft };
    },
    replace: (start, end, text) => {
      if (refusal) return { ok: false, reason: refusal };
      const next = replaceTextRange(draft, start, end, text);
      draft = next.text;
      caret = next.cursor;
      return { ok: true, draft };
    },
  };

  return {
    port,
    read: () => draft,
    /** Somebody typing, at an offset of their choosing. */
    type: (text: string, at: number) => {
      draft = `${draft.slice(0, at)}${text}${draft.slice(at)}`;
      caret = at + text.length;
    },
    refuse: (reason: string) => {
      refusal = reason;
    },
  };
}

const guess = (text: string) => ({ text, final: false });
const settled = (text: string) => ({ text, final: true });

describe("insertedSpan", () => {
  test("the words, and not the spacing the composer added around them", () => {
    // A span that swallowed the leading space would run two words together on revision.
    expect(insertedSpan("fix the test", "fix the test and ", "and")).toEqual({ start: 13, end: 16 });
  });

  test("an insertion into an empty box", () => {
    expect(insertedSpan("", "fix ", "fix")).toEqual({ start: 0, end: 3 });
  });

  test("an insertion in the middle of a half-typed line", () => {
    expect(insertedSpan("before after", "before spoken after", "spoken")).toEqual({ start: 7, end: 13 });
  });

  test("text the composer transformed falls back to the whole changed run", () => {
    // The words as typed are nowhere in the draft, so the span widens to the whole changed run.
    expect(insertedSpan("", "docs/readme ", "Docs/readme")).toEqual({ start: 0, end: 12 });
  });
});

describe("the interim writer", () => {
  test("a guess goes into the box and each revision replaces the last", () => {
    const composer = box();
    const writer = createDictationWriter(composer.port);

    writer.write(guess("recur"));
    expect(composer.read()).toBe("recur ");
    writer.write(guess("record"));
    expect(composer.read()).toBe("record ");
    writer.write(guess("recording"));
    expect(composer.read()).toBe("recording ");
  });

  test("a final settles the words and the next utterance starts after them", () => {
    const composer = box();
    const writer = createDictationWriter(composer.port);

    writer.write(guess("fix the"));
    writer.write(settled("fix the failing test"));
    expect(composer.read()).toBe("fix the failing test ");

    // The span was forgotten at the final, so this opens a new one at the caret.
    writer.write(guess("and"));
    expect(composer.read()).toBe("fix the failing test and ");
    writer.write(settled("and push it"));
    expect(composer.read()).toBe("fix the failing test and push it ");
  });

  test("a finalised silence takes the unconfirmed guess back out", () => {
    const composer = box();
    const writer = createDictationWriter(composer.port);
    writer.write(guess("uh"));
    expect(composer.read()).toBe("uh ");
    // Deepgram finalising the quiet at the end of an utterance.
    writer.write(settled(""));
    expect(composer.read()).toBe(" ");
  });

  test("dictation starts at whatever the box already holds", () => {
    const composer = box("half typed");
    const writer = createDictationWriter(composer.port);
    writer.write(guess("and"));
    writer.write(settled("and spoken"));
    expect(composer.read()).toBe("half typed and spoken ");
  });

  test("somebody typing INSIDE the span drops it, and the guess so far becomes theirs", () => {
    const composer = box();
    const writer = createDictationWriter(composer.port);
    writer.write(guess("recording"));
    expect(composer.read()).toBe("recording ");

    // The offsets now mean something else; writing through them would eat what was typed.
    composer.type("XX", 3);
    expect(composer.read()).toBe("recXXording ");

    writer.write(guess("recording now"));
    // The guess so far is left alone and the new one opens a fresh span at the caret.
    expect(composer.read()).toContain("recXX");
    expect(composer.read()).toContain("recording now");
  });

  test("somebody typing BEFORE the span drops it too, rather than writing at a shifted offset", () => {
    const composer = box();
    const writer = createDictationWriter(composer.port);
    writer.write(guess("spoken"));
    composer.type("typed ", 0);
    expect(composer.read()).toBe("typed spoken ");

    writer.write(settled("spoken words"));
    // A span applied at its old offsets would have replaced "typed " itself.
    expect(composer.read()).toStartWith("typed ");
    expect(composer.read()).toContain("spoken words");
  });

  test("after the person has typed, the words keep flowing rather than stopping", () => {
    const composer = box();
    const writer = createDictationWriter(composer.port);
    writer.write(guess("one"));
    composer.type("!", 0);
    // The new span is live again, so later revisions still replace in place.
    writer.write(guess("two"));
    const afterTwo = composer.read();
    writer.write(guess("three"));
    expect(composer.read()).toBe(afterTwo.replace("two", "three"));
  });

  test("an empty guess with no span open writes nothing at all", () => {
    const composer = box("untouched");
    const writer = createDictationWriter(composer.port);
    writer.write(guess(""));
    writer.write(settled(""));
    expect(composer.read()).toBe("untouched");
  });

  test("a composer that refuses hands the refusal back, and the span is dropped", () => {
    const composer = box();
    const writer = createDictationWriter(composer.port);
    composer.refuse("The message box is not on screen.");
    const answer = writer.write(guess("anything"));
    expect(answer).toEqual({ ok: false, reason: "The message box is not on screen." });
  });

  test("forget leaves the words where they are and only drops the span", () => {
    const composer = box();
    const writer = createDictationWriter(composer.port);
    writer.write(guess("said out loud"));
    writer.forget();
    expect(composer.read()).toBe("said out loud ");
    writer.write(guess("more"));
    expect(composer.read()).toBe("said out loud more ");
  });
});
