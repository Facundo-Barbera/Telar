/**
 * The highlighter, against the real Shiki.
 *
 * Not mocked, because the two things worth pinning are both facts about the
 * library rather than about our code: that `defaultColor: false` really does hand
 * back BOTH themes per token (the whole reason light/dark works without a
 * re-render), and that every refusal path returns plain text rather than throwing
 * inside a panel.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { carryTokens, highlight, MAX_HIGHLIGHT_BYTES, type HighlightedLine } from "./highlight";

describe("highlight", () => {
  test("tokenises, and every token carries both themes", () => {
    // The dual-theme custom properties ARE the feature: globals.css switches
    // between them on `.dark`, so an open file repaints on a theme change without
    // this app tokenising it again.
    return highlight("const a: number = 1;\nconst b = a;\n", "typescript").then((lines) => {
      expect(lines).toBeDefined();
      // Three lines: two of code and the empty one after the trailing newline.
      expect(lines).toHaveLength(3);
      const first = lines![0]!;
      expect(first.map((token) => token.text).join("")).toBe("const a: number = 1;");
      for (const token of first) {
        expect(token.style["--shiki-light"], token.text).toBeDefined();
        expect(token.style["--shiki-dark"], token.text).toBeDefined();
      }
      // And the two themes genuinely differ, or one of them is not being applied.
      expect(first[0]!.style["--shiki-light"]).not.toBe(first[0]!.style["--shiki-dark"]);
    });
  });

  test("no language means no highlighting, not an error", async () => {
    // The kind table returns no `lang` for a format with no grammar worth a
    // chunk download, and the viewer draws plain text for it.
    expect(await highlight("hello", undefined)).toBeUndefined();
  });

  test("a language Shiki does not ship degrades to plain text", async () => {
    // Checked against the bundle rather than tried: an unknown id throws inside
    // the loader, and a typo in the kind table must not take the panel with it.
    expect(await highlight("hello", "not-a-real-language")).toBeUndefined();
  });

  test("a file too large to be worth tokenising is left alone", async () => {
    // Past the cap this would block the window for longer than reading it takes,
    // for content nobody scrolls to.
    const huge = "const a = 1;\n".repeat(Math.ceil(MAX_HIGHLIGHT_BYTES / 12) + 1);
    expect(huge.length).toBeGreaterThan(MAX_HIGHLIGHT_BYTES);
    expect(await highlight(huge, "typescript")).toBeUndefined();
  });
});

/**
 * THE FLICKER, STATED AS AN INVARIANT: a keystroke may cost the LINE it was
 * typed on its colours for one debounce. It may never cost any other line.
 */
describe("carryTokens", () => {
  /** Tokens that say which line they came from, so a test can assert WHICH
   *  line's colours were carried rather than merely that some were. */
  function marked(text: string): { of: string; lines: HighlightedLine[] } {
    return { of: text, lines: text.split("\n").map((line) => [{ text: line, style: { "--shiki-light": line } }]) };
  }

  /** The carried layer as one string per line: its token text, or `null` for a
   *  hole the caller will draw as plain text. */
  function carried(previous: { of: string; lines: HighlightedLine[] }, next: string): (string | null)[] {
    return carryTokens(previous, next).map((line) => (line ? line.map((token) => token.text).join("") : null));
  }

  test("a keystroke leaves every other line coloured", () => {
    // THE WHOLE BUG. Before this, one character typed on line three dropped the
    // tokens for all five lines and the file blinked monochrome until Shiki
    // answered ~120ms later — at typing speed, continuously.
    const before = marked("one\ntwo\nthree\nfour\nfive");
    expect(carried(before, "one\ntwo\nthreX\nfour\nfive")).toEqual(["one", "two", null, "four", "five"]);
  });

  test("text that has not moved keeps the tokens it already had", () => {
    const before = marked("a\nb\nc");
    expect(carryTokens(before, "a\nb\nc")).toBe(before.lines);
  });

  test("an inserted line moves the colours below it down, rather than dropping them", () => {
    // Pressing Return is the case where a naive index-for-index carry paints
    // every line below the caret with its neighbour's colours.
    const before = marked("one\ntwo\nthree");
    expect(carried(before, "one\ntwo\n\nthree")).toEqual(["one", "two", null, "three"]);
  });

  test("a deleted line closes the gap without shifting the colours below it", () => {
    const before = marked("one\ntwo\nthree\nfour");
    expect(carried(before, "one\nthree\nfour")).toEqual(["one", "three", "four"]);
  });

  test("typing at the end of the file leaves the lines above it alone", () => {
    const before = marked("one\ntwo");
    expect(carried(before, "one\ntwo\nthr")).toEqual(["one", "two", null]);
  });

  test("typing at the start of the file leaves the lines below it alone", () => {
    const before = marked("one\ntwo\nthree");
    expect(carried(before, "Xone\ntwo\nthree")).toEqual([null, "two", "three"]);
  });

  test("no line is ever painted with another line's colours", () => {
    // The invariant that makes carrying safe at all: a carried line's token text
    // must be exactly the source line it is drawn under, or the reader sees one
    // line's words in another line's place.
    const before = marked("alpha\nbeta\ngamma\ndelta");
    for (const next of ["alpha\nbeta\ngamma\ndelta", "alpha\nbetaX\ngamma\ndelta", "alpha\ngamma\ndelta", "alpha\nbeta\nnew\ngamma\ndelta", "", "x"]) {
      const lines = next.split("\n");
      carryTokens(before, next).forEach((line, at) => {
        if (line) expect(line.map((token) => token.text).join(""), `line ${at} of ${JSON.stringify(next)}`).toBe(lines[at]);
      });
    }
  });

  test("the carried layer always has exactly one entry per source line", () => {
    // The caret invariant: the coloured layer, the gutter and the textarea all
    // count lines the same way or the caret stops sitting on its own glyphs.
    const before = marked("one\ntwo\nthree");
    for (const next of ["one", "one\ntwo\nthree\nfour\nfive", "", "\n\n\n"]) {
      expect(carryTokens(before, next), next).toHaveLength(next.split("\n").length);
    }
  });

  test("shorter tokens than lines is a hole, not a crash", () => {
    // Defensive: `highlight` returns one entry per line, but a carried layer is
    // itself a valid input to the next carry and already has holes in it.
    expect(carried({ of: "a\nb\nc", lines: [[{ text: "a", style: {} }]] }, "a\nb\nX")).toEqual(["a", null, null]);
  });
});
