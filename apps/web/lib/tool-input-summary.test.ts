// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { toolInputSummary } from "./tool-input-summary";

/**
 * #354 — "ds_scratch ds_scratch". The row's verb and its argument both fell
 * back to the tool's name, so the lane said it twice and said nothing about
 * what the call did.
 */
describe("the one line beside a tool's name", () => {
  test("a scratch cell shows its first line of code", () => {
    expect(toolInputSummary({ code: "import pandas as pd\ndf = pd.read_csv('planets.csv')" })).toBe("import pandas as pd");
  });

  test("a compile shows the file it was given", () => {
    expect(toolInputSummary({ path: "paper/main.tex" })).toBe("paper/main.tex");
  });

  test("code wins over the path beside it — the code is what a reader recognises", () => {
    expect(toolInputSummary({ path: "cell-3.py", code: "df.describe()" })).toBe("df.describe()");
  });

  test("leading blank lines are not the summary", () => {
    expect(toolInputSummary({ code: "\n\n   plot(df)\n" })).toBe("plot(df)");
  });

  test("a bare string input is its own summary", () => {
    expect(toolInputSummary("SELECT 1")).toBe("SELECT 1");
  });

  test("a list of paths reads as a list", () => {
    expect(toolInputSummary({ paths: ["a.tex", "b.tex"] })).toBe("a.tex, b.tex");
  });

  test("an input the rule does not know is named, because an id alone says nothing", () => {
    expect(toolInputSummary({ sessionId: "session_399fbd", runId: "run_87ae80" })).toBe("sessionId: session_399fbd");
  });

  test("nested payloads are never flattened into the row", () => {
    // A blob printed inline is the payload, not a summary of it — and the row
    // already has a disclosure for the payload.
    expect(toolInputSummary({ filter: { status: ["open"] } })).toBeUndefined();
  });

  test("a call with no input says nothing rather than repeating the tool's name", () => {
    expect(toolInputSummary(undefined)).toBeUndefined();
    expect(toolInputSummary({})).toBeUndefined();
    expect(toolInputSummary({ code: "   " })).toBeUndefined();
  });
});
