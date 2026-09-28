import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { IDENTITY_COLORS, IdentityColor, isIdentityColor, isTelarIcon, TELAR_ICONS, TelarIcon } from "../src/index";

describe("the icon set", () => {
  test("is forty ids, each distinct", () => {
    expect(TELAR_ICONS).toHaveLength(40);
    expect(new Set(TELAR_ICONS).size).toBe(TELAR_ICONS.length);
  });

  test("every id is lucide-shaped — lowercase kebab, which is how a glyph is found", () => {
    for (const icon of TELAR_ICONS) expect(icon).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
  });

  test("the guard answers for the set and refuses everything else", () => {
    expect(isTelarIcon("globe")).toBe(true);
    expect(TELAR_ICONS.every((icon) => isTelarIcon(icon))).toBe(true);
    expect(isTelarIcon("🏠")).toBe(false);
    expect(isTelarIcon("Globe")).toBe(false);
    expect(isTelarIcon(undefined)).toBe(false);
    expect(isTelarIcon(null)).toBe(false);
    expect(isTelarIcon("")).toBe(false);
  });

  test("the iPhone pairs every id with a symbol, and only these ids", () => {
    const swift = readFileSync(new URL("../../../apps/ios/TelarMobile/UI/TelarIcons.swift", import.meta.url), "utf8");
    const paired = [...swift.matchAll(/^\s*"([a-z0-9-]+)":\s*"[^"]+",?$/gm)].map((match) => match[1]);
    expect(paired.sort()).toEqual([...TELAR_ICONS].sort());
  });

  test("the schema parses exactly the list", () => {
    expect(TelarIcon.options).toEqual([...TELAR_ICONS]);
    expect(TelarIcon.safeParse("briefcase").success).toBe(true);
    expect(TelarIcon.safeParse("brief-case").success).toBe(false);
  });
});

describe("the identity colours", () => {
  test("are the eight `--subject-*` hues, spelled out so a rename cannot pass", () => {
    // Written literally rather than folded from the source: these token names
    // are what `globals.css` and `Theme.swift` also spell, and a test that only
    // counted them would let a rename through silently.
    expect([...IDENTITY_COLORS]).toEqual(["plum", "sea", "moss", "amber", "slate", "rose", "sky", "sand"]);
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
