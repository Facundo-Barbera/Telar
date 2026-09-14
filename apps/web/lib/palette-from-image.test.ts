// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { dominantHues, halfFor, halfFromBase, pickSecondary, rgbToHsl, themeFromPalette, themeFromPixels, tintForSaturation, type Rgb } from "./palette-from-image";
import { cssColorToHex, TELAR_DARK, TELAR_LIGHT, THEME_TOKENS } from "./theme-palettes";
import { FOREGROUND_SURFACES } from "./theme-designer";
import { contrastRatio, parseVsCodeColor } from "./vscode-theme-import";

/** An RGBA buffer of `count` copies of one colour — a synthetic "photograph"
 *  the extraction can chew on without a canvas anywhere. */
function fill(color: Rgb, count: number, alpha = 255): Uint8ClampedArray {
  const data = new Uint8ClampedArray(count * 4);
  for (let i = 0; i < count; i += 1) {
    data[i * 4] = color.r;
    data[i * 4 + 1] = color.g;
    data[i * 4 + 2] = color.b;
    data[i * 4 + 3] = alpha;
  }
  return data;
}

function concat(...parts: Uint8ClampedArray[]): Uint8ClampedArray {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8ClampedArray(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const BLUE: Rgb = { r: 0, g: 0, b: 255 };
const ORANGE: Rgb = { r: 240, g: 140, b: 20 };
const GREY: Rgb = { r: 128, g: 128, b: 128 };

describe("rgbToHsl", () => {
  test("the primaries land where a colour wheel says they do", () => {
    expect(rgbToHsl(255, 0, 0).hue).toBeCloseTo(0, 1);
    expect(rgbToHsl(0, 255, 0).hue).toBeCloseTo(120, 1);
    expect(rgbToHsl(0, 0, 255).hue).toBeCloseTo(240, 1);
  });

  test("grey has no hue and no saturation", () => {
    const grey = rgbToHsl(128, 128, 128);
    expect(grey.saturation).toBe(0);
    expect(grey.lightness).toBeCloseTo(0.502, 2);
  });
});

describe("dominantHues", () => {
  test("an all-blue image reads as blue", () => {
    const [top] = dominantHues(fill(BLUE, 64));
    expect(top).toBeDefined();
    expect(top.hue).toBeGreaterThanOrEqual(240);
    expect(top.hue).toBeLessThanOrEqual(260);
    expect(top.chroma).toBeCloseTo(1, 2);
  });

  test("a grey image falls back to nothing — there is no hue to find", () => {
    expect(dominantHues(fill(GREY, 64))).toEqual([]);
  });

  test("black and white pixels are skipped, not counted as a hue", () => {
    expect(dominantHues(fill({ r: 0, g: 0, b: 0 }, 32))).toEqual([]);
    expect(dominantHues(fill({ r: 255, g: 255, b: 255 }, 32))).toEqual([]);
    // A near-black blue is shadow, not a colour decision.
    expect(dominantHues(fill({ r: 0, g: 0, b: 20 }, 32))).toEqual([]);
  });

  test("transparent pixels contribute nothing", () => {
    expect(dominantHues(fill(BLUE, 32, 0))).toEqual([]);
  });

  test("the strongest family comes first, and minor ones follow", () => {
    const colors = dominantHues(concat(fill(BLUE, 100), fill(ORANGE, 20)));
    expect(colors.length).toBe(2);
    expect(colors[0].hue).toBeCloseTo(240, 0);
    expect(colors[1].hue).toBeGreaterThan(20);
    expect(colors[1].hue).toBeLessThan(45);
    expect(colors[0].weight).toBeGreaterThan(colors[1].weight);
  });

  test("hue is averaged around the circle, not across it", () => {
    // 350° and 10° are ten degrees apart; a naive mean would say 180°.
    const wrap = concat(fill({ r: 255, g: 0, b: 42 }, 32), fill({ r: 255, g: 42, b: 0 }, 32));
    const [top] = dominantHues(wrap, { buckets: 1 });
    expect(Math.min(top.hue, 360 - top.hue)).toBeLessThan(5);
  });

  test("plain {r,g,b} records work as well as an ImageData buffer", () => {
    const [top] = dominantHues([BLUE, BLUE, BLUE]);
    expect(top.hue).toBeCloseTo(240, 0);
  });

  test("at most `count` families come back", () => {
    const many = concat(fill(BLUE, 40), fill(ORANGE, 30), fill({ r: 20, g: 200, b: 60 }, 20), fill({ r: 200, g: 20, b: 200 }, 10));
    expect(dominantHues(many).length).toBe(3);
    expect(dominantHues(many, { count: 1 }).length).toBe(1);
  });

  test("a desaturated wash is grey enough to ignore", () => {
    expect(dominantHues(fill({ r: 130, g: 128, b: 126 }, 64))).toEqual([]);
  });
});

describe("tintForSaturation", () => {
  test("it stays inside the tint band, whatever it is fed", () => {
    for (const s of [-5, 0, 0.3, 1, 12, Number.NaN]) {
      const tint = tintForSaturation(s);
      expect(tint).toBeGreaterThanOrEqual(0.008);
      expect(tint).toBeLessThanOrEqual(0.022);
    }
  });

  test("more saturation means more tint", () => {
    expect(tintForSaturation(0.9)).toBeGreaterThan(tintForSaturation(0.2));
  });
});

describe("pickSecondary", () => {
  const primary = { hue: 240, chroma: 0.8, weight: 100 };

  test("a present, distinct second hue is taken", () => {
    expect(pickSecondary([primary, { hue: 30, chroma: 0.6, weight: 40 }])?.hue).toBe(30);
  });

  test("a faint one is not", () => {
    expect(pickSecondary([primary, { hue: 30, chroma: 0.6, weight: 5 }])).toBeUndefined();
  });

  test("a near-identical hue is not — it would read as a mistake", () => {
    expect(pickSecondary([primary, { hue: 250, chroma: 0.6, weight: 80 }])).toBeUndefined();
  });

  test("nothing to pick from is fine", () => {
    expect(pickSecondary([])).toBeUndefined();
    expect(pickSecondary([primary])).toBeUndefined();
  });
});

describe("themeFromPalette", () => {
  const oklch = /^oklch\(/;

  test("both halves carry every themable token as an oklch value", () => {
    const theme = themeFromPalette(dominantHues(fill(BLUE, 64)));
    for (const token of THEME_TOKENS) {
      expect(theme.light[token]).toMatch(oklch);
      expect(theme.dark[token]).toMatch(oklch);
    }
    expect(Object.keys(theme.light).length).toBe(THEME_TOKENS.length);
    expect(Object.keys(theme.dark).length).toBe(THEME_TOKENS.length);
  });

  test("it is labelled for where it came from", () => {
    expect(themeFromPalette(dominantHues(fill(BLUE, 64))).label).toBe("From image");
  });

  test("the canvas takes the image's hue at a restrained chroma", () => {
    const theme = themeFromPalette(dominantHues(fill(BLUE, 64)));
    const parsed = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(theme.light.background);
    expect(parsed).not.toBeNull();
    const [, lightness, chroma, hue] = parsed as RegExpExecArray;
    expect(Number(hue)).toBeGreaterThanOrEqual(240);
    expect(Number(hue)).toBeLessThanOrEqual(260);
    expect(Number(chroma)).toBeLessThan(0.03); // a tint, never a poster
    // Telar's lightness spine is untouched: every contrast claim is about L.
    // Read off TELAR_LIGHT rather than written as a literal — the spine is
    // allowed to move (it did, when light mode got its elevation ladder), and
    // what this test is for is that a derived theme MOVES WITH IT.
    expect(lightness).toBe(/^oklch\(([\d.]+) /.exec(TELAR_LIGHT.background)![1]);
  });

  test("the whole light half keeps Telar's lightnesses exactly", () => {
    const theme = themeFromPalette(dominantHues(fill(ORANGE, 64)));
    for (const token of THEME_TOKENS) {
      const base = /^oklch\(([\d.]+) /.exec(TELAR_LIGHT[token])?.[1];
      const derived = /^oklch\(([\d.]+) /.exec(theme.light[token])?.[1];
      expect(derived).toBe(base);
    }
  });

  test("a value that is not a plain oklch triple is copied through untouched", () => {
    // The dark half's border carries an alpha; re-hueing it would drop that.
    const theme = themeFromPalette(dominantHues(fill(BLUE, 64)));
    expect(theme.dark.border).toBe(TELAR_DARK.border);
  });

  test("a grey image yields Telar itself rather than an invented tint", () => {
    const theme = themeFromPalette(dominantHues(fill(GREY, 64)));
    expect(theme.light).toEqual(TELAR_LIGHT);
    expect(theme.dark).toEqual(TELAR_DARK);
  });

  test("a secondary hue reaches the chips and the rail's hover, and nothing else", () => {
    const theme = themeFromPalette(dominantHues(concat(fill(BLUE, 100), fill(ORANGE, 60))));
    const hueOf = (value: string) => Number(/ ([\d.]+)\)$/.exec(value)?.[1]);
    expect(hueOf(theme.light.secondary)).toBeLessThan(60);
    expect(hueOf(theme.light["sidebar-accent"])).toBeLessThan(60);
    expect(hueOf(theme.light.background)).toBeGreaterThan(200);
    expect(hueOf(theme.dark.sidebar)).toBeGreaterThan(200);
  });
});

describe("themeFromPixels", () => {
  test("pixels in, wearable theme out", () => {
    const theme = themeFromPixels(fill(ORANGE, 64));
    expect(theme.label).toBe("From image");
    expect(theme.light.background).toMatch(/^oklch\(/);
  });
});

/**
 * THE COMPOSER'S BASE, AND THE PROMISE IT MAKES.
 *
 * The composition derives its sixteen tokens from one base colour (#471), so
 * the base is the only colour decision a person has to get right — and the
 * whole reason it goes through THIS engine rather than becoming `--background`
 * directly is that the engine keeps Telar's lightness spine. Any base
 * therefore yields a palette whose text sits readably on its surfaces: you
 * cannot pick a canvas your foreground disappears into, because the foreground
 * moves with it.
 *
 * That is a claim about EVERY base, so it is tested against a spread of them
 * rather than against one, in both states, on every foreground/surface pair
 * the designer itself repairs to.
 */
describe("halfFromBase", () => {
  /** A hue wheel plus the awkward ones: black, white, a mid grey, a neon and a
   *  colour written the way the app actually stores them. */
  const BASES = [
    "#ff0000", "#ff8800", "#ffee00", "#88ff00", "#00ff44", "#00ffee",
    "#0044ff", "#5500ff", "#cc00ff", "#ff0088", "#000000", "#ffffff",
    "#808080", "#1e1e2e", "#f8f8f9", "oklch(0.5 0.2 240)",
  ];

  test("every base keeps every foreground readable, in both states", () => {
    for (const base of BASES) {
      for (const mode of ["light", "dark"] as const) {
        const half = halfFromBase(base, mode);
        for (const [text, surface] of FOREGROUND_SURFACES) {
          const fg = parseVsCodeColor(cssColorToHex(half[text]));
          const bg = parseVsCodeColor(cssColorToHex(half[surface]));
          expect(fg, `${base} ${mode} ${text}`).not.toBeNull();
          expect(bg, `${base} ${mode} ${surface}`).not.toBeNull();
          // WCAG AA for body copy — the bar the designer and the VS Code
          // importer both repair to.
          expect(contrastRatio(fg!, bg!), `${base} ${mode} ${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  test("a base with no hue to trust derives Telar itself", () => {
    // Same rule a grey photograph gets: under the saturation floor there is no
    // hue, and inventing one tints the identity look on a rounding error.
    expect(halfFromBase("#808080", "light")).toEqual(TELAR_LIGHT);
    expect(halfFromBase("#ffffff", "dark")).toEqual(TELAR_DARK);
    expect(halfFromBase("not a colour", "light")).toEqual(TELAR_LIGHT);
  });

  test("a coloured base moves every token onto its hue, and only C and H", () => {
    const half = halfFromBase("#0044ff", "light");
    const lightness = (value: string) => /^oklch\(([\d.]+)/.exec(value)?.[1];
    for (const token of THEME_TOKENS) {
      // The lightness string is carried across VERBATIM — it is the contrast
      // contract, and re-formatting a number is a chance to drift it.
      expect(lightness(half[token]), token).toBe(lightness(TELAR_LIGHT[token]));
    }
    // #0044ff is hue 224 in HSL, and that is the hue every token lands on.
    expect(half.background).toMatch(/ 224[0-9.]*\)$/);
  });

  test("an override wins over what the base derived, and only where it is set", () => {
    const state = { base: "#0044ff", overrides: { card: "#ffffff" } };
    const half = halfFor(state, "light");
    expect(half.card).toBe("#ffffff");
    // Everything absent still follows the base, which is what makes clearing
    // one override hand that token back.
    expect(half.background).toBe(halfFromBase("#0044ff", "light").background);
  });
});
