// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { isStarterLook, STARTER_LOOKS, STARTER_PREFIX } from "./starter-looks";
import { parseLook, serializeLook } from "./looks";
import { ACCENTS } from "./appearance";
import { THEME_TOKENS } from "./theme-palettes";

describe("starter looks", () => {
  test("the shelf is never empty", () => {
    expect(STARTER_LOOKS.length).toBeGreaterThan(0);
  });

  test("every starter is a Look this build can wear", () => {
    // The round trip is the real bar: a starter that would not survive
    // serialize/parse is one the shelf could offer and Save could not keep.
    for (const look of STARTER_LOOKS) {
      const parsed = parseLook(JSON.parse(serializeLook(look)));
      expect(parsed).not.toBeUndefined();
      expect(parsed?.label).toBe(look.label);
      expect(parsed?.backdrop.kind).toBe(look.backdrop.kind);
    }
  });

  test("both halves are concrete — every token, no inherited blanks", () => {
    for (const look of STARTER_LOOKS) {
      for (const mode of ["light", "dark"] as const) {
        for (const token of THEME_TOKENS) expect(typeof look.theme[mode][token]).toBe("string");
      }
    }
  });

  test("accents are real accents", () => {
    for (const look of STARTER_LOOKS) expect(ACCENTS).toContain(look.accent);
  });

  test("ids are unique and marked as starters", () => {
    const ids = STARTER_LOOKS.map((look) => look.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const look of STARTER_LOOKS) {
      expect(look.id.startsWith(STARTER_PREFIX)).toBe(true);
      expect(isStarterLook(look)).toBe(true);
    }
  });

  test("a saved look is not mistaken for a starter", () => {
    expect(isStarterLook({ ...STARTER_LOOKS[0], id: "look-1" })).toBe(false);
  });

  test("at least one starter brings no backdrop, and at least one does", () => {
    expect(STARTER_LOOKS.some((look) => look.backdrop.kind === "none")).toBe(true);
    expect(STARTER_LOOKS.some((look) => look.backdrop.kind !== "none")).toBe(true);
  });
});
