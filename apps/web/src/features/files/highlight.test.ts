// Runs against real Shiki: dual-theme output and non-throwing refusals are library facts.
import { describe, expect, test } from "bun:test";
import { carryTokens, highlight, MAX_HIGHLIGHT_BYTES, type HighlightedLine } from "./highlight";

describe("highlight", () => {
  test("tokenises, and every token carries both themes", () => {
    // globals.css switches between these on `.dark`, so no re-tokenising on theme change.
    return highlight("const a: number = 1;\nconst b = a;\n", "typescript").then((lines) => {
      expect(lines).toBeDefined();
      expect(lines).toHaveLength(3);
      const first = lines![0]!;
      expect(first.map((token) => token.text).join("")).toBe("const a: number = 1;");
      for (const token of first) {
        expect(token.style["--shiki-light"], token.text).toBeDefined();
        expect(token.style["--shiki-dark"], token.text).toBeDefined();
      }
      expect(first[0]!.style["--shiki-light"]).not.toBe(first[0]!.style["--shiki-dark"]);
    });
  });

  test("no language means no highlighting, not an error", async () => {
    expect(await highlight("hello", undefined)).toBeUndefined();
  });

  test("a language Shiki does not ship degrades to plain text", async () => {
    // An unknown id throws inside the loader, so it's checked against the bundle.
    expect(await highlight("hello", "not-a-real-language")).toBeUndefined();
  });

  test("a file too large to be worth tokenising is left alone", async () => {
    const huge = "const a = 1;\n".repeat(Math.ceil(MAX_HIGHLIGHT_BYTES / 12) + 1);
    expect(huge.length).toBeGreaterThan(MAX_HIGHLIGHT_BYTES);
    expect(await highlight(huge, "typescript")).toBeUndefined();
  });
});

/** A keystroke may cost only its own line's colours for one debounce. */
describe("carryTokens", () => {
  function marked(text: string): { of: string; lines: HighlightedLine[] } {
    return { of: text, lines: text.split("\n").map((line) => [{ text: line, style: { "--shiki-light": line } }]) };
  }

  /** `null` marks a hole drawn as plain text. */
  function carried(previous: { of: string; lines: HighlightedLine[] }, next: string): (string | null)[] {
    return carryTokens(previous, next).map((line) => (line ? line.map((token) => token.text).join("") : null));
  }

  test("a keystroke leaves every other line coloured", () => {
    const before = marked("one\ntwo\nthree\nfour\nfive");
    expect(carried(before, "one\ntwo\nthreX\nfour\nfive")).toEqual(["one", "two", null, "four", "five"]);
  });

  test("text that has not moved keeps the tokens it already had", () => {
    const before = marked("a\nb\nc");
    expect(carryTokens(before, "a\nb\nc")).toBe(before.lines);
  });

  test("an inserted line moves the colours below it down, rather than dropping them", () => {
    // A naive index-for-index carry would shift every line below the caret.
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
    // A carried line's token text must equal the source line it's drawn under.
    const before = marked("alpha\nbeta\ngamma\ndelta");
    for (const next of ["alpha\nbeta\ngamma\ndelta", "alpha\nbetaX\ngamma\ndelta", "alpha\ngamma\ndelta", "alpha\nbeta\nnew\ngamma\ndelta", "", "x"]) {
      const lines = next.split("\n");
      carryTokens(before, next).forEach((line, at) => {
        if (line) expect(line.map((token) => token.text).join(""), `line ${at} of ${JSON.stringify(next)}`).toBe(lines[at]);
      });
    }
  });

  test("the carried layer always has exactly one entry per source line", () => {
    // Layer, gutter and textarea must count lines the same or the caret drifts.
    const before = marked("one\ntwo\nthree");
    for (const next of ["one", "one\ntwo\nthree\nfour\nfive", "", "\n\n\n"]) {
      expect(carryTokens(before, next), next).toHaveLength(next.split("\n").length);
    }
  });

  test("shorter tokens than lines is a hole, not a crash", () => {
    // A carried layer, with holes, is itself valid input to the next carry.
    expect(carried({ of: "a\nb\nc", lines: [[{ text: "a", style: {} }]] }, "a\nb\nX")).toEqual(["a", null, null]);
  });
});
