// @ts-expect-error no @types/bun in this workspace — the runtime is `bun test`
import { describe, expect, test } from "bun:test";
import { previewPlainText } from "./preview-text";

// The collapse previewOf applies after the strip, replicated here so the
// assertions read like what a list surface actually shows.
const glimpse = (md: string) => previewPlainText(md).replace(/\s+/g, " ").trim();

describe("previewPlainText", () => {
  test("strips the marks a real reply carries", () => {
    expect(
      glimpse("`read-fold-test-3` finished — **done**, $0.0768. Fold summary:\n> Ultra's storage"),
    ).toBe("read-fold-test-3 finished — done, $0.0768. Fold summary: Ultra's storage");
  });

  test("keeps link text, drops the url", () => {
    expect(glimpse("see [the docs](https://example.com/x) for more")).toBe(
      "see the docs for more",
    );
    expect(glimpse("![diagram](https://example.com/d.png) as shown")).toBe(
      "diagram as shown",
    );
  });

  test("drops fence lines but keeps the code between them", () => {
    expect(glimpse("Result:\n```ts\nconst a = 1;\n```\nDone.")).toBe(
      "Result: const a = 1; Done.",
    );
  });

  test("strips line-anchored headings and bullets", () => {
    expect(glimpse("## Plan\n- first\n- second\n1. third")).toBe("Plan first second third");
  });

  test("snake_case survives; underscore emphasis at word edges does not", () => {
    expect(glimpse("renamed read_fold_test to _emphasis_ style")).toBe(
      "renamed read_fold_test to emphasis style",
    );
  });

  test("plain text passes through untouched", () => {
    expect(glimpse("no markdown here, just $1.23 and a > b comparison")).toBe(
      "no markdown here, just $1.23 and a > b comparison",
    );
  });

  test("lone backticks are noise either way", () => {
    expect(glimpse("an unbalanced `span that got cut")).toBe("an unbalanced span that got cut");
  });
});
