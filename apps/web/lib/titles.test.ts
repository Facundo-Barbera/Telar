// @ts-expect-error no @types/bun in this workspace
import { describe, expect, test } from "bun:test";
import { cleanTitle } from "./titles";

// Only cleanTitle (pure post-processing) is tested here — generateTitle
// spawns the Claude Agent SDK subprocess and is intentionally not exercised
// in unit tests.

describe("cleanTitle", () => {
  test("null/undefined/empty/whitespace-only input all yield null", () => {
    expect(cleanTitle(null)).toBeNull();
    expect(cleanTitle(undefined)).toBeNull();
    expect(cleanTitle("")).toBeNull();
    expect(cleanTitle("   ")).toBeNull();
    expect(cleanTitle("\n\t  \n")).toBeNull();
  });

  test("passes a clean title straight through", () => {
    expect(cleanTitle("Fix login redirect bug")).toBe("Fix login redirect bug");
  });

  test("collapses internal newlines and runs of whitespace", () => {
    expect(cleanTitle("Fix\nlogin\nbug")).toBe("Fix login bug");
    expect(cleanTitle("Fix   login    bug")).toBe("Fix login bug");
    expect(cleanTitle("  Fix login bug  ")).toBe("Fix login bug");
    expect(cleanTitle("Fix\r\nlogin\r\nbug")).toBe("Fix login bug");
  });

  test("strips a single layer of wrapping quotes", () => {
    expect(cleanTitle('"Fix login bug"')).toBe("Fix login bug");
    expect(cleanTitle("'Fix login bug'")).toBe("Fix login bug");
    expect(cleanTitle("`Fix login bug`")).toBe("Fix login bug");
    expect(cleanTitle("“Fix login bug”")).toBe("Fix login bug");
    expect(cleanTitle("‘Fix login bug’")).toBe("Fix login bug");
  });

  test("strips nested/doubled wrapping quotes", () => {
    expect(cleanTitle('\'"Fix login bug"\'')).toBe("Fix login bug");
    expect(cleanTitle('""Fix login bug""')).toBe("Fix login bug");
  });

  test("does not strip a quote character that isn't a matching wrap", () => {
    expect(cleanTitle('"Fix login bug')).toBe('"Fix login bug');
    expect(cleanTitle("Say \"hi\" to bug")).toBe('Say "hi" to bug');
  });

  test("strips trailing punctuation", () => {
    expect(cleanTitle("Fix login bug.")).toBe("Fix login bug");
    expect(cleanTitle("Fix login bug!")).toBe("Fix login bug");
    expect(cleanTitle("Fix login bug?")).toBe("Fix login bug");
    expect(cleanTitle("Fix login bug...")).toBe("Fix login bug");
    expect(cleanTitle("Fix login bug!?.")).toBe("Fix login bug");
    expect(cleanTitle("Fix login bug,")).toBe("Fix login bug");
    expect(cleanTitle("Fix login bug:")).toBe("Fix login bug");
    expect(cleanTitle("Fix login bug;")).toBe("Fix login bug");
    expect(cleanTitle("Fix login bug…")).toBe("Fix login bug");
  });

  test("does not touch internal punctuation, only trailing", () => {
    expect(cleanTitle("Fix login bug, again.")).toBe("Fix login bug, again");
  });

  test("strips quotes and trailing punctuation regardless of nesting order", () => {
    expect(cleanTitle('"Fix login bug."')).toBe("Fix login bug");
    expect(cleanTitle('"Fix login bug!".')).toBe("Fix login bug");
    expect(cleanTitle("'Fix login bug!'.")).toBe("Fix login bug");
  });

  test("an all-punctuation or all-quote 'title' collapses to null", () => {
    expect(cleanTitle("...")).toBeNull();
    expect(cleanTitle('""')).toBeNull();
    expect(cleanTitle('"..."')).toBeNull();
  });

  test("rejects refusal-looking output", () => {
    expect(cleanTitle("I'm sorry, I can't help with that.")).toBeNull();
    expect(cleanTitle("I cannot generate a title for this.")).toBeNull();
    expect(cleanTitle("I can not summarize this request.")).toBeNull();
    expect(cleanTitle("I won't be able to title this.")).toBeNull();
    expect(cleanTitle("I apologize, but this is unclear.")).toBeNull();
    expect(cleanTitle("As an AI, I cannot do that.")).toBeNull();
    expect(cleanTitle("Sorry, I don't understand.")).toBeNull();
    expect(cleanTitle("Unable to determine a title.")).toBeNull();
    expect(cleanTitle("I don't have enough context to title this.")).toBeNull();
    expect(cleanTitle("I need more information to help.")).toBeNull();
    // case-insensitive
    expect(cleanTitle("I CAN'T create a title for that.")).toBeNull();
  });

  test("does not false-positive on legitimate titles that merely start similarly", () => {
    expect(cleanTitle("Cannot connect to database error")).toBe(
      "Cannot connect to database error",
    );
    expect(cleanTitle("Sorry state machine refactor")).toBeNull(); // starts with "sorry" — accepted tradeoff of a simple prefix check
  });

  test("caps length at 60 code points, leaving shorter titles untouched", () => {
    const exactly60 = "a".repeat(60);
    expect(cleanTitle(exactly60)).toBe(exactly60);
    expect(cleanTitle(exactly60)?.length).toBe(60);

    const over60 = "a".repeat(75);
    const result = cleanTitle(over60);
    expect(result).toBe("a".repeat(60));
    expect(result?.length).toBe(60);
  });

  test("truncation is code-point-safe and never splits a surrogate pair", () => {
    // Each of these emoji is a single Unicode code point encoded as a UTF-16
    // surrogate pair (2 code units). 70 of them = 140 UTF-16 units, but only
    // 70 code points — truncating to 60 code points must yield exactly 60
    // whole emoji (120 UTF-16 units), never a lone unpaired surrogate.
    const emoji = "😀".repeat(70);
    const result = cleanTitle(emoji);
    expect(result).not.toBeNull();
    const codePoints = Array.from(result as string);
    expect(codePoints.length).toBe(60);
    expect(result).toBe("😀".repeat(60));
    // A split surrogate would produce unpaired lone surrogates and/or a
    // string whose UTF-16 length isn't exactly 2x the code-point count.
    expect((result as string).length).toBe(120);
  });

  test("truncation trims trailing whitespace exposed by the cut", () => {
    const words = "word ".repeat(20); // 100 chars, cut lands mid-gap at 60
    const result = cleanTitle(words);
    expect(result?.endsWith(" ")).toBe(false);
  });

  test("real-world messy model output end to end", () => {
    expect(cleanTitle('  "Refactor the payment retry logic!!"  \n')).toBe(
      "Refactor the payment retry logic",
    );
  });
});
