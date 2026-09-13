import { describe, expect, test } from "bun:test";
import {
  IDENTITY_COLORS,
  IdentityColor,
  isIdentityColor,
  isTelarIcon,
  SpoolSubjectColor,
  TELAR_ICONS,
  TelarIcon,
} from "../src/index";

/**
 * THE IDENTITY VOCABULARY IS A CLOSED SET, AND A SHARED ONE.
 *
 * Two surfaces spend it — browser profiles (#366) and project icons — and a
 * renderer maps every id to a glyph by hand (`apps/web/lib/telar-icons.tsx`).
 * That makes the list's SHAPE load-bearing in a way a list of strings usually is
 * not: a duplicate silently costs a slot in the picker grid, an id that is not
 * kebab-case cannot be looked up in lucide, and a set that drifts from the
 * Spool's hues means the same eight colours are drawn from two sources.
 */
describe("the icon set", () => {
  test("is forty ids, each distinct", () => {
    // Forty is the picker's own claim: a grid a person scans in one look. If
    // this number moves, the grid's shape was a decision someone made.
    expect(TELAR_ICONS).toHaveLength(40);
    expect(new Set(TELAR_ICONS).size).toBe(TELAR_ICONS.length);
  });

  test("every id is lucide-shaped — lowercase kebab, which is how a glyph is found", () => {
    for (const icon of TELAR_ICONS) expect(icon).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
  });

  test("the guard answers for the set and refuses everything else", () => {
    expect(isTelarIcon("globe")).toBe(true);
    expect(TELAR_ICONS.every((icon) => isTelarIcon(icon))).toBe(true);
    // The three things a person might reasonably try, and the owner's own
    // "not emojis though, icons": none of them is an icon id.
    expect(isTelarIcon("🏠")).toBe(false);
    expect(isTelarIcon("Globe")).toBe(false);
    expect(isTelarIcon(undefined)).toBe(false);
    expect(isTelarIcon(null)).toBe(false);
    expect(isTelarIcon("")).toBe(false);
  });

  test("the schema parses exactly the list", () => {
    expect(TelarIcon.options).toEqual([...TELAR_ICONS]);
    expect(TelarIcon.safeParse("briefcase").success).toBe(true);
    expect(TelarIcon.safeParse("brief-case").success).toBe(false);
  });
});

describe("the identity colours", () => {
  test("are the eight the Spool already paints identities with", () => {
    // Restated rather than imported (these are not Spool records) — so the one
    // thing that must be true is that the two lists have not drifted. If they
    // do, `--subject-*` stops covering half the app's colour tokens.
    expect([...IDENTITY_COLORS]).toEqual([...SpoolSubjectColor.options]);
    expect(IDENTITY_COLORS).toHaveLength(8);
    expect(new Set(IDENTITY_COLORS).size).toBe(8);
  });

  test("the guard and the schema agree, and neither takes a hex", () => {
    expect(IDENTITY_COLORS.every((color) => isIdentityColor(color))).toBe(true);
    // A free hex is the thing the closed set exists to prevent: a hue nothing
    // can restate in the other theme, chosen once and wrong ever after.
    expect(isIdentityColor("#ff0000")).toBe(false);
    expect(isIdentityColor("chartreuse")).toBe(false);
    expect(isIdentityColor(undefined)).toBe(false);
    expect(IdentityColor.options).toEqual([...IDENTITY_COLORS]);
  });
});
