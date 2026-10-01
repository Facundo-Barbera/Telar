import { describe, expect, test } from "bun:test";
import { monogramHue, monogramInitial } from "./monogram";

describe("monogramHue", () => {
  test("is stable and in range", () => {
    expect(monogramHue("Telar")).toBe(monogramHue("Telar"));
    expect(monogramHue("Telar")).not.toBe(monogramHue("telar"));
    for (const text of ["a", "Telar", "🚀 rockets", "Ålesund"]) {
      const hue = monogramHue(text);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });
});

describe("monogramInitial", () => {
  test("takes the first grapheme, not the first code unit", () => {
    expect(monogramInitial("telar")).toBe("T");
    expect(monogramInitial("  spaced")).toBe("S");
    expect(monogramInitial("🚀 rockets")).toBe("🚀");
    expect(monogramInitial("")).toBe("?");
  });
});
