/**
 * THE DARK LADDER IS FOUR RUNGS, AND BOTH PLATFORMS CLIMB THE SAME ONE.
 *
 * Dark mode separates two surfaces by lightness, so the ladder IS the elevation
 * — canvas, rail, card, popover, four steps a person reads as depth. iOS was
 * audited as being one rung short, with menus sitting on `card` where the web
 * would use `popover`.
 *
 * It was not short. `Theme.composerSurface` was `0xFFFFFF / 0x1C1C1C`, which is
 * `--popover` byte for byte: the rung existed and the ROLE was missing, so the
 * next surface to float above a card had no name to reach for. Issue #250 item
 * 14 named it, and that is all it did — see the comment on `Theme.popover` for
 * why adopting it on menus is not a token's job.
 *
 * This file is the tripwire for the rung that has no call sites yet. An unused
 * token is exactly the kind that drifts: nothing renders it, so nothing catches
 * a hand-edit, and it stops being the web's value long before anyone reaches for
 * it. Each step is converted from globals.css rather than compared against a
 * remembered hex.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("./globals.css", import.meta.url), "utf8");
const theme = readFileSync(new URL("../../ios/TelarMobile/Views/Theme.swift", import.meta.url), "utf8");

/** The declarations of the first `.dark` block — the dark palette. */
const dark = (() => {
  const start = css.indexOf(".dark {");
  expect(start, "globals.css declares a .dark palette").toBeGreaterThan(-1);
  return css.slice(start, css.indexOf("\n}", start));
})();

/** An achromatic `oklch(L 0 0)` to its sRGB hex. The rungs carry no chroma. */
function greyToHex(L: number): string {
  const encoded = L ** 3 <= 0.0031308 ? 12.92 * L ** 3 : 1.055 * (L ** 3) ** (1 / 2.4) - 0.055;
  const channel = Math.max(0, Math.min(255, Math.round(encoded * 255)))
    .toString(16)
    .toUpperCase()
    .padStart(2, "0");
  return `0x${channel.repeat(3)}`;
}

/** A dark rung's hex, converted from its own declaration. */
function rung(token: string): string {
  const found = new RegExp(`${token}: oklch\\(([\\d.]+) 0 0\\);`).exec(dark);
  expect(found, `the dark palette declares ${token} as an achromatic oklch()`).not.toBeNull();
  return greyToHex(Number(found![1]));
}

/** The `dark:` half of a `Theme.swift` token's adaptive pair. */
function iosDark(token: string): string {
  const found = new RegExp(`static let ${token} = adaptive\\(light: (0x[0-9A-Fa-f]{6}), dark: (0x[0-9A-Fa-f]{6})\\)`).exec(theme);
  expect(found, `Theme.${token} is an adaptive pair`).not.toBeNull();
  return `0x${found![2].slice(2).toUpperCase()}`;
}

describe("the four dark rungs, web to iOS", () => {
  // The rail is `--sidebar` on the web and `sheet` on iOS: same rung, and the
  // names differ because each platform names it after what sits there.
  const LADDER: [string, string, string][] = [
    ["canvas", "--background", "canvas"],
    ["rail", "--sidebar", "sheet"],
    ["card", "--card", "card"],
    ["popover", "--popover", "popover"],
  ];

  for (const [name, token, ios] of LADDER) {
    test(`${name}: ${token} is Theme.${ios}`, () => {
      expect(iosDark(ios)).toBe(rung(token));
    });
  }

  test("and they are four DISTINCT steps — a ladder with a repeat is a flat surface", () => {
    const steps = LADDER.map(([, token]) => rung(token));
    expect(new Set(steps).size).toBe(4);
  });

  test("each step is lighter than the one below it", () => {
    // parseInt base 16 — `Number("0A")` is NaN, and a ladder asserted with NaNs
    // sorts as equal and passes while saying nothing.
    const steps = LADDER.map(([, token]) => parseInt(rung(token).slice(2, 4), 16));
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
  });
});

describe("the rung iOS had without a name", () => {
  test("the composer's glass is the popover rung, not its own value", () => {
    expect(theme).toContain("static let composerSurface = popover");
  });

  test("and the light half is white, as --popover is", () => {
    expect(theme).toMatch(/static let popover = adaptive\(light: 0xFFFFFF, dark: 0x1C1C1C\)/);
    expect(css.slice(css.indexOf(":root"))).toContain("--popover: oklch(1 0 0);");
  });

  test("why no menu adopts it is written down, not left to be rediscovered", () => {
    expect(theme).toContain("whose chrome the system draws and which takes no");
  });
});
