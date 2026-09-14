/**
 * THE ACCENT THE PHONE SHOWS IS THE ACCENT THE COCKPIT CHOSE.
 *
 * The colour layer is a byte-exact port between the two platforms, and that is
 * the part of this design system that works. Nothing tested it. The 29 mapped
 * roles were verified once, by hand, in an audit — and a hand-verified table is
 * true on the day it is written and unowned the day after.
 *
 * Issue #250 item 11 settled that the phone FOLLOWS its paired cockpit's accent
 * rather than holding its own, which makes these eight hues a port rather than
 * a parallel set of choices — so drift between them is a defect, not a taste
 * difference, and this is the file that says so. It converts globals.css's
 * `oklch()` itself and compares against the literals in `Theme.swift`.
 *
 * IT VALIDATES ITS OWN CONVERTER FIRST. A colour-space transform that is subtly
 * wrong would agree with nothing and fail everything, which is noise rather
 * than a signal; so before it asserts anything about accents it reproduces six
 * status tokens whose iOS literals were independently verified. Three of those
 * six are out of sRGB's gamut and clip, which also pins the convention this
 * port uses for the out-of-gamut accents: clip per channel, as the shipped
 * tokens do, rather than gamut-map by reducing chroma.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const globals = readFileSync(new URL("./globals.css", import.meta.url), "utf8");
const theme = readFileSync(new URL("../../ios/TelarMobile/Views/Theme.swift", import.meta.url), "utf8");

/**
 * `oklch()` to an sRGB hex, the transform a browser does: Oklab's inverse
 * matrices to linear sRGB, then the sRGB transfer function, then a per-channel
 * clamp. The matrices are Björn Ottosson's published inverse.
 */
function oklchToHex(L: number, C: number, hue: number): string {
  const h = (hue * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);

  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;

  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];

  const channel = (v: number) => {
    const encoded = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(encoded * 255)));
  };
  return `0x${linear.map((v) => channel(v).toString(16).toUpperCase().padStart(2, "0")).join("")}`;
}

/** The `oklch(L C H)` of `token` inside the first block matching `selector`. */
function oklchOf(selector: string, token: string): [number, number, number] {
  const start = globals.indexOf(selector);
  expect(start, `globals.css declares ${selector}`).toBeGreaterThan(-1);
  const found = new RegExp(`${token}:\\s*oklch\\(([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)\\)`).exec(globals.slice(start));
  expect(found, `${selector} declares ${token} as an oklch()`).not.toBeNull();
  return [Number(found![1]), Number(found![2]), Number(found![3])];
}

/**
 * The body of one `var` in `Theme.Accent`. Each accent appears once per var, so
 * `case .sky:` alone is ambiguous — the fill's row and the glyph's row both
 * match it, and a test that read the wrong one would assert a fill against a
 * near-black and still pass on the day the two happened to agree.
 */
function accentVar(name: "fill" | "glyph"): string {
  const start = theme.indexOf(`var ${name}: Color {`);
  expect(start, `Theme.Accent declares ${name}`).toBeGreaterThan(-1);
  const end = theme.indexOf("\n        }", start);
  return theme.slice(start, end === -1 ? undefined : end);
}

/** The `light:`/`dark:` pair a row of that var carries. */
function swiftPair(source: string, anchor: string): [string, string] {
  const found = new RegExp(`${anchor}[^\\n]*adaptive\\(light: (0x[0-9A-Fa-f]{6}), dark: (0x[0-9A-Fa-f]{6})\\)`).exec(source);
  expect(found, `Theme.swift carries a light/dark pair for ${anchor}`).not.toBeNull();
  // The digits, not the `0x` — uppercasing the prefix too would compare
  // `0XAA2340` against a converter that writes `0x`, and fail on the notation.
  const normalise = (literal: string) => `0x${literal.slice(2).toUpperCase()}`;
  return [normalise(found![1]), normalise(found![2])];
}

describe("the converter, against tokens whose port was verified independently", () => {
  // Three of these clip: --success and --info land a channel at or near zero,
  // and --warning light does too. They are in the list on purpose.
  const VERIFIED: [string, number, number, number, string][] = [
    ["--primary light", 0.488, 0.16, 264, "0x2F58B9"],
    ["--primary dark", 0.68, 0.16, 264, "0x6594FA"],
    ["--warning light", 0.515, 0.11, 72, "0x8E5B01"],
    ["--warning dark", 0.78, 0.15, 72, "0xF2A635"],
    ["--success light", 0.495, 0.108, 162, "0x02744E"],
    ["--info light", 0.51, 0.09, 215, "0x007386"],
  ];

  for (const [name, L, C, hue, expected] of VERIFIED) {
    test(`${name} converts to ${expected}`, () => {
      expect(oklchToHex(L, C, hue)).toBe(expected);
    });
  }
});

/**
 * The eight, as globals.css states them. `indigo` is the default and its block
 * exists only for the settings pane's swatch row, which is why it is read from
 * the `[data-accent="indigo"]` blocks like the rest rather than from `:root`.
 */
const ACCENTS = ["indigo", "sky", "sea", "moss", "amber", "rose", "plum", "violet"] as const;

describe("the eight accents are the same colour on both platforms", () => {
  for (const accent of ACCENTS) {
    test(`${accent} fill`, () => {
      const light = oklchToHex(...oklchOf(`[data-accent="${accent}"] {`, "--primary"));
      const dark = oklchToHex(...oklchOf(`.dark [data-accent="${accent}"]`, "--primary"));
      expect(swiftPair(accentVar("fill"), `case .${accent}:`)).toEqual([light, dark]);
    });
  }

  test("all eight are present on the iOS side, and no ninth", () => {
    const cases = /case indigo, sky, sea, moss, amber, rose, plum, violet/.test(theme);
    expect(cases, "Theme.Accent lists exactly the cockpit's eight").toBe(true);
  });
});

describe("the glyph re-tints with the hue, so no accent wears another's near-black", () => {
  // `.dark [data-accent=…]` sets --primary-foreground for every hue but indigo,
  // whose value lives in the .dark block as the base token.
  for (const accent of ACCENTS.filter((a) => a !== "indigo")) {
    test(`${accent} dark glyph`, () => {
      const dark = oklchToHex(...oklchOf(`.dark [data-accent="${accent}"]`, "--primary-foreground"));
      expect(swiftPair(accentVar("glyph"), `case .${accent}:`)).toEqual(["0xFFFFFF", dark]);
    });
  }

  test("indigo's glyph is the base dark --primary-foreground", () => {
    const dark = oklchToHex(...oklchOf(".dark {", "--primary-foreground"));
    expect(dark).toBe("0x070F21");
  });
});

describe("the phone reads the table rather than restating the default", () => {
  test("Theme.accent is the indigo row", () => {
    expect(theme).toContain("static let accent = Accent.indigo.fill");
  });

  test("Theme.primaryGlyph is the indigo row", () => {
    expect(theme).toContain("static let primaryGlyph = Accent.indigo.glyph");
  });

  test("and the doctrine the values follow is written down", () => {
    expect(theme).toContain("the phone follows its paired cockpit");
  });
});
