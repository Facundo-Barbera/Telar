/**
 * THE SEMANTIC TINTS, MEASURED — the OUTCOME #691 left unpinned (#705).
 *
 * #691 pinned the MECHANISM: every `.tint-*` is `color-mix(in oklab,
 * var(--<tone>) var(--tint-floor), var(--card))`, and globals.test.ts asserts
 * that declaration character for character, on the five-colour state
 * vocabulary, with the floor declared exactly once. Not one of those guards
 * evaluates a colour. That is what makes them theme-independent — and it is
 * exactly what leaves the question they cannot ask: once the mix is done, is
 * anything actually VISIBLE?
 *
 * THREE SEPARATIONS, AND THEY DO NOT ALL PULL THE SAME WAY:
 *
 *   ELEVATION    the fill, apart from the --card it is mixed into. A SURFACE
 *                step, held to the 1.075:1 the palette already argues for
 *                --background against --card — not a 4.5:1 text bar.
 *   READABILITY  the ink still clearing 4.5:1 ON THE FILL. `text-success` sits
 *                on `.tint-success` (diff-surface.tsx:771), and the fill is
 *                made of THE SAME TOKEN as the ink — so every step the fill
 *                takes away from the card is a step toward its own text.
 *                Raising the floor buys elevation and spends readability.
 *   TONE         `tint-success` apart from `tint-destructive`. Added versus
 *                removed is the most meaningful distinction on a diff, and
 *                CONTRAST CANNOT SEE IT: at the shipped floor those two fills
 *                sit at 1.01:1, which is a luminance ratio reporting
 *                "indistinguishable" about a green and a red. This separation
 *                is a perceptual distance or it is nothing.
 *
 * WHY THIS IS ARITHMETIC AND NOT A SCREENSHOT. `color-mix(in oklab, A p%, B)`
 * is linear interpolation in Oklab, so a fill is computable in closed form from
 * two declared colours and one percentage. No browser, no paint, no flake.
 *
 * WHAT THIS FILE IS NOT. It measures; it decides nothing. The floor stays in
 * globals.css, which is the only place it paints from — tint-separation.test.ts
 * reads it back out of the stylesheet rather than keeping a second copy here,
 * for the same reason #691 put it in one declaration.
 */

import { cssColorToHex } from "./theme-palettes";
import { contrastRatio, parseVsCodeColor } from "./vscode-theme-import";

export type Oklab = { L: number; a: number; b: number };
type Rgb = { r: number; g: number; b: number };

/**
 * THE ELEVATION BAR, quoted rather than invented: globals.css moved --background
 * to 0.975 so that a white --card clears 1.075:1 against it, and calls anything
 * less "not a step, a rounding error". A tint IS an elevation — the same fill
 * one rung up — so it answers to the same number.
 */
export const TINT_ELEVATION = 1.075;

/** WCAG AA for body copy — the bar the importer and the designer already hold. */
export const TINT_READABLE = 4.5;

/**
 * ONE JND IN OKLAB. Not a number chosen here: CSS Color 4's own gamut-mapping
 * algorithm defines the just-noticeable difference as 0.02 in OKLCh, which is
 * the same space and scale this file measures in. Two fills closer than this
 * are one colour as far as a reader scanning a diff is concerned.
 */
export const TONE_JND = 0.02;

// ── Oklab, both ways ─────────────────────────────────────────────────────────

/** `oklch()`'s three components: a number, a percentage of its own basis, or
 *  `none` — the same grammar `cssColorToHex` reads, and for the same reason. */
function component(raw: string, percentBasis: number): number {
  if (raw === "none") return 0;
  const number = Number.parseFloat(raw);
  if (!Number.isFinite(number)) return Number.NaN;
  return raw.endsWith("%") ? (number / 100) * percentBasis : number;
}

function degrees(raw: string): number {
  if (raw === "none") return 0;
  const number = Number.parseFloat(raw);
  if (!Number.isFinite(number)) return Number.NaN;
  if (raw.endsWith("turn")) return number * 360;
  if (raw.endsWith("grad")) return number * 0.9;
  if (raw.endsWith("rad")) return (number * 180) / Math.PI;
  return number;
}

function srgbToLinear(value: number): number {
  const ratio = value / 255;
  return ratio <= 0.04045 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value: number): number {
  const encoded = value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, encoded)) * 255);
}

/**
 * Any colour the palette can hold, as Oklab.
 *
 * OKLCH TAKES THE DIRECT ROUTE rather than going through `cssColorToHex`,
 * because that is what the browser does: `color-mix(in oklab, …)` interpolates
 * the DECLARED values at full precision and gamut-maps once, at the end. The
 * near-white cards the built-in themes actually use — `oklch(0.999 0.004 65)`
 * — lose about 0.0024 ΔE to an 8-bit sRGB round trip. That is a tenth of the
 * JND above, so it would not change a verdict; it is simply not a cost worth
 * paying to save a regex.
 *
 * Everything else — hex, `rgb()`, a named colour — is already an sRGB value,
 * so it goes through the converter the rest of the palette shares and comes
 * back through the forward matrices. Total: an unreadable value resolves to
 * `cssColorToHex`'s own mid-grey rather than throwing, which keeps this usable
 * on the foreign-JSON paths in theme-designer.ts.
 */
export function toOklab(value: string): Oklab {
  const oklch = /^oklch\(\s*(none|[\d.]+%?)\s+(none|[\d.]+%?)\s+(none|-?[\d.]+(?:deg|rad|grad|turn)?)/i.exec(value.trim());
  if (oklch) {
    const lightness = component(oklch[1], 1);
    const chroma = component(oklch[2], 0.4);
    const hue = degrees(oklch[3]);
    if (Number.isFinite(lightness) && Number.isFinite(chroma) && Number.isFinite(hue)) {
      const radians = (hue * Math.PI) / 180;
      return { L: lightness, a: chroma * Math.cos(radians), b: chroma * Math.sin(radians) };
    }
  }
  const rgb = parseVsCodeColor(cssColorToHex(value)) ?? { r: 128, g: 128, b: 128 };
  const r = srgbToLinear(rgb.r);
  const g = srgbToLinear(rgb.g);
  const b = srgbToLinear(rgb.b);
  const long = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const medium = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const short = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * long + 0.793617785 * medium - 0.0040720468 * short,
    a: 1.9779984951 * long - 2.428592205 * medium + 0.4505937099 * short,
    b: 0.0259040371 * long + 0.7827717662 * medium - 0.808675766 * short,
  };
}

/** The same matrices `cssColorToHex` ends on, kept here so a MIXED colour —
 *  which exists only in Oklab and never as a declared string — can be measured
 *  by the sRGB-luminance helpers the rest of the contrast policy uses. */
export function oklabToRgb({ L, a, b }: Oklab): Rgb {
  const long = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const medium = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const short = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: linearToSrgb(4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short),
    g: linearToSrgb(-1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short),
    b: linearToSrgb(-0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short),
  };
}

/** Euclidean distance in Oklab — the space is built so that this IS perceptual
 *  distance, which is the whole reason the mix happens in it. */
export function deltaEOk(first: Oklab, second: Oklab): number {
  return Math.hypot(first.L - second.L, first.a - second.a, first.b - second.b);
}

// ── The mix, and the three separations ───────────────────────────────────────

/**
 * `color-mix(in oklab, ink floor, card)`, in closed form.
 *
 * `floor` is the fraction of the INK, matching the CSS: `12%` means twelve
 * parts of the state token to eighty-eight of the card.
 */
export function tintOf(ink: string, card: string, floor: number): Oklab {
  const a = toOklab(ink);
  const b = toOklab(card);
  return {
    L: a.L * floor + b.L * (1 - floor),
    a: a.a * floor + b.a * (1 - floor),
    b: a.b * floor + b.b * (1 - floor),
  };
}

/**
 * The two separations a --card can move: whether the fill reads as a step off
 * the card, and whether the ink still reads on the fill.
 *
 * BOTH ARE REPORTED, NEVER JUST THE FAILING ONE, because they answer to the
 * floor in OPPOSITE DIRECTIONS and a caller that sees only one will reach for
 * the wrong lever.
 */
export function measureTint(ink: string, card: string, floor: number): { elevation: number; readability: number } {
  const fill = oklabToRgb(tintOf(ink, card, floor));
  return {
    elevation: contrastRatio(fill, oklabToRgb(toOklab(card))),
    readability: contrastRatio(oklabToRgb(toOklab(ink)), fill),
  };
}

/**
 * How far apart two tones' fills are — and it does not take a card, which is
 * not an omission but the result.
 *
 * `mix(A, card, p) − mix(B, card, p) = p·(A − B)`: the card appears in both
 * fills with the same weight and cancels EXACTLY. So this separation is a
 * property of the floor and the two state tokens alone, a Look cannot touch
 * it, and there is nothing here for a theme-time repair to fix. It belongs to
 * the floor, which is why the test that owns it is a test and not a policy.
 */
export function toneSeparation(first: string, second: string, floor: number): number {
  return floor * deltaEOk(toOklab(first), toOklab(second));
}
