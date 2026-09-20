/**
 * HOW YOU LIKE TO READ A DIFF, PARSED — issue #694.
 *
 * The three defaults are decisions, not conveniences, so they are pinned
 * individually and with the reason beside each: split is opt-in, wrap is off
 * because a long line should scroll, and whitespace is NOT ignored because a
 * whitespace-only change is still a change until somebody says otherwise.
 *
 * A PURE PARSE, so none of this needs a window. The hook around it is four
 * lines of `useSyncExternalStore` over the same function.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { DEFAULT_DIFF_VIEW, parseDiffView } from "./diff-view";

describe("the diff view preference", () => {
  test("nothing stored is stacked, unwrapped, and whitespace-sensitive", () => {
    // Each of the three is a decision the issue argues for; a change here is a
    // change of mind, not a tidy-up.
    expect(parseDiffView(null)).toEqual({ layout: "stacked", wrap: false, ignoreWhitespace: false });
    expect(DEFAULT_DIFF_VIEW).toEqual(parseDiffView(null));
  });

  test("a stored choice survives, both ways round", () => {
    expect(parseDiffView('{"layout":"split","wrap":true,"ignoreWhitespace":true}')).toEqual({
      layout: "split",
      wrap: true,
      ignoreWhitespace: true,
    });
    expect(parseDiffView('{"layout":"stacked","wrap":false,"ignoreWhitespace":false}')).toEqual(DEFAULT_DIFF_VIEW);
  });

  test("one bad key costs only its own field", () => {
    // Total per FIELD rather than per record: a hand-edited file with one typo
    // should not silently reset the other two choices.
    expect(parseDiffView('{"layout":"diagonal","wrap":true}')).toEqual({ layout: "stacked", wrap: true, ignoreWhitespace: false });
    expect(parseDiffView('{"layout":"split","wrap":"yes"}')).toEqual({ layout: "split", wrap: false, ignoreWhitespace: false });
  });

  test("a corrupt record is a first run, never a surface that will not paint", () => {
    // The same rule `readOverrides` and `parseAppearance` follow, for the same
    // reason: a half-written localStorage entry must not cost you the panel.
    for (const raw of ["", "not json", "null", "[]", '"split"', "42"]) {
      expect(parseDiffView(raw), `${JSON.stringify(raw)} falls back whole`).toEqual(DEFAULT_DIFF_VIEW);
    }
  });
});
