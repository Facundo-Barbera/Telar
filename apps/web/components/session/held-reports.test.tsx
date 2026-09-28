// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HELD_DETAIL, heldLabel, HeldReportsView } from "./held-reports";

const view = (held: number) => renderToStaticMarkup(<HeldReportsView held={held} />);

describe("the held row", () => {
  test("admits what it is holding, and says nothing when it holds nothing", () => {
    expect(heldLabel(3)).toBe("3 held");
    expect(heldLabel(0)).toBeUndefined();
    expect(view(3)).toContain(">3 held<");
    expect(view(0)).not.toContain("tabular-nums");
  });

  test("the held row says its count in words, with no coloured rail", () => {
    expect(view(3)).not.toContain("data-tone");
    expect(view(3)).not.toContain("before:");
  });

  test("offers no cadence any more, and says where the reports go", () => {
    expect(view(0)).not.toContain("As they arrive");
    expect(view(0)).not.toContain('aria-haspopup');
    // The markup escapes the apostrophe, so match the sentence up to it.
    expect(view(0)).toContain(HELD_DETAIL.split("'")[0]!);
    expect(view(0)).toContain("Reports from peers");
  });
});
