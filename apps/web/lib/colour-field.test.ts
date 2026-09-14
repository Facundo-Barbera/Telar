/**
 * WHAT A COLOUR FIELD ACCEPTS — the three shapes the owner named, and the
 * refusal that keeps a typo from becoming a colour (#471).
 *
 * NO DOM HERE ON PURPOSE. `parseCssColor`'s last resort asks a canvas, which
 * only exists in a browser; everything this file asserts is one of the branches
 * that answers before that, which is also every shape the composer stores.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { normaliseColourText } from "./colour-field";

describe("normaliseColourText", () => {
  test("six-digit hex comes back as itself, lowercased", () => {
    expect(normaliseColourText("#1E1E2E")).toBe("#1e1e2e");
    expect(normaliseColourText("  #0d151c  ")).toBe("#0d151c");
  });

  test("the short form expands", () => {
    expect(normaliseColourText("#abc")).toBe("#aabbcc");
    expect(normaliseColourText("#FFF")).toBe("#ffffff");
  });

  test("the hash is optional, because typing it is not how people type hex", () => {
    expect(normaliseColourText("1e1e2e")).toBe("#1e1e2e");
    expect(normaliseColourText("abc")).toBe("#aabbcc");
  });

  test("oklch is a colour a reader can copy out of this app's own rows", () => {
    // globals.css §ACCENTS, indigo's light half — what the token rows show.
    expect(normaliseColourText("oklch(0.488 0.16 264)")).toBe("#2f58b9");
    expect(normaliseColourText("oklch(100% 0 0)")).toBe("#ffffff");
  });

  test("alpha is dropped rather than refused — a swatch cannot show it", () => {
    expect(normaliseColourText("#11223344")).toBe("#112233");
    expect(normaliseColourText("oklch(1 0 0 / 10%)")).toBe("#ffffff");
  });

  test("rgb() lands too, since the parser under it already reads one", () => {
    expect(normaliseColourText("rgb(20, 20, 20)")).toBe("#141414");
    expect(normaliseColourText("rgb(255 0 0)")).toBe("#ff0000");
  });

  /** THE POINT OF RETURNING UNDEFINED. `cssColorToHex` answers `#808080` for
   *  all of these, which is right for a stored value and wrong for a typed one:
   *  it would turn a typo into a real grey stop nobody chose. */
  test("nonsense is nothing, not grey", () => {
    for (const text of ["", "   ", "bananas", "#12", "#1234567", "oklch(", "oklch(bananas)", "#gggggg"]) {
      expect(normaliseColourText(text)).toBeUndefined();
    }
  });
});
