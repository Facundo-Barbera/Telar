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
  return rgbToOklab(parseVsCodeColor(cssColorToHex(value)) ?? { r: 128, g: 128, b: 128 });
}

/** An 8-bit sRGB triple as Oklab — the inverse of `oklabToRgb`, and the way
 *  back for a colour that has already been through the screen. */
export function rgbToOklab({ r: red, g: green, b: blue }: Rgb): Oklab {
  const r = srgbToLinear(red);
  const g = srgbToLinear(green);
  const b = srgbToLinear(blue);
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

/**
 * WOULD A SCREEN SHOW THIS COLOUR, OR SOMETHING ELSE?
 *
 * `oklabToRgb` clamps each channel independently, which is NOT what a browser
 * does with an out-of-gamut `oklch()`: CSS Color 4 gamut-maps by reducing
 * CHROMA. For MEASURING a colour that already arrived as sRGB the distinction
 * never comes up. It comes up the moment something INVENTS a colour — which is
 * what the repair below does, and emitting one the browser will quietly move
 * somewhere this file never measured would be the same class of silent
 * wrongness #705 is about.
 *
 * SO THE TEST IS PERCEPTUAL, NOT A CHANNEL BOUND, and it has to be: the shipped
 * light `--success` sits so close to the sRGB boundary that a tenth of a step
 * of lightness puts it nominally outside, while the colour a screen shows moves
 * by almost nothing. What matters is not "did a channel clip" but "is what
 * paints still the colour that was measured" — so the question is asked in the
 * same JND this file already uses for tone separation, and answered by a round
 * trip through the screen's own 8 bits.
 */
export function paintsAsMeasured(value: Oklab, tolerance = TONE_JND): boolean {
  return deltaEOk(value, rgbToOklab(oklabToRgb(value))) <= tolerance;
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

// ── The repair: move the INK, never the card (#705) ──────────────────────────

/**
 * THE THREE TONES `.tint-*` PAINTS, and the whole vocabulary this file repairs.
 *
 * `.tint-warning` has no call site outside globals.css today. It is carried
 * anyway for the reason the test above carries it: the class exists, and the
 * next reader to reach for it should find it already held to the bar.
 */
export const TINT_TONES = ["success", "warning", "destructive"] as const;
export type TintTone = (typeof TINT_TONES)[number];

/** Which scheme's vocabulary — the window's colour scheme, not a theme id. */
export type TintScheme = "light" | "dark";

/**
 * `--tint-floor: 12%`, AS THE FRACTION `color-mix` MEANS BY IT.
 *
 * A SECOND COPY OF A NUMBER THAT PAINTS FROM globals.css, and the only reason
 * it exists is that the repair runs in the browser, where there is no
 * stylesheet to read. `tint-separation.test.ts` pulls the real declaration out
 * of globals.css and asserts this equals it, so the copy cannot drift — the
 * same bargain `theme-palettes.ts` strikes with its weight tables.
 */
export const TINT_FLOOR = 0.12;

/**
 * THE STATE VOCABULARY, BOTH SCHEMES — and the reason repairing it is safe.
 *
 * `--success` / `--warning` / `--destructive` are NOT in `THEME_TOKENS`: no
 * Look can set them, no import writes them, no picker exposes them. So moving
 * one cannot change anything a person chose, because there is no way for a
 * person to have chosen it. That is the entire argument for repairing THIS end
 * of the mix rather than the `--card` at the other end, which somebody did
 * choose — and `tint-separation.test.ts` holds the premise as its own
 * assertion, because every claim here rests on it.
 *
 * Read back out of globals.css by that test, character for character.
 */
export const STATE_INK: Record<TintScheme, Record<TintTone, string>> = {
  light: {
    success: "oklch(0.495 0.108 162)",
    warning: "oklch(0.515 0.11 72)",
    destructive: "oklch(0.50 0.19 25.5)",
  },
  dark: {
    success: "oklch(0.73 0.15 162)",
    warning: "oklch(0.78 0.15 72)",
    destructive: "oklch(0.7 0.19 25.5)",
  },
};

/**
 * WHAT HAPPENED TO ONE TONE ON ONE CARD.
 *
 * `ink` IS ALWAYS WHAT TO PAINT, in all three arms — the `stranded` arm hands
 * back the SHIPPED value untouched, so a caller that reads only `.ink` can
 * never move a colour the search failed to fix. "Report, never rewrite" is a
 * property of the type here rather than a rule a caller has to remember.
 */
export type InkRepair =
  /** The shipped ink already clears both separations on this card. The fixed
   *  point, and the case every Look this build ships lands in. */
  | { outcome: "holds"; ink: string }
  /** A lightness clears both. `moved` is how far in ΔE-Oklab — which is exactly
   *  |ΔL|, since hue and chroma are held. */
  | { outcome: "repaired"; ink: string; moved: number }
  /** No lightness clears both: the card is sitting on the ink's own lightness,
   *  so ELEVATION is what fails and no ink can answer it. Nothing changes. */
  | { outcome: "stranded"; ink: string };

/** The same three-part grammar `retint` writes and refuses to reformat. A value
 *  that is not one — an alpha form, a hex — has no lightness to move. */
const INK_OKLCH = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+(-?[\d.]+)\s*\)$/;

/**
 * THE SEARCH GRID. Three decimals is what the authored vocabulary is written
 * to, so a candidate lands on the grid the stylesheet already uses rather than
 * inventing a precision nobody else in the palette has.
 */
const INK_STEP = 0.001;

/**
 * THE ONE TERM IN THE EXPRESSION NOBODY CHOSE, MOVED UNTIL THE TINT READS.
 *
 * WHY LIGHTNESS AND NOTHING ELSE. `retint` carries a token's LIGHTNESS across
 * verbatim and rewrites chroma and hue, because lightness is the contrast
 * contract. This is that rule read backwards: contrast is what failed, so
 * lightness is the only lever that can answer it — and holding hue and chroma
 * is what keeps `tint-success` and `tint-destructive` as far apart afterwards
 * as they were before (the separation `toneSeparation` proves card-independent
 * lives almost entirely in a and b). Repairing by chroma would fix the ratio
 * and merge added with removed.
 *
 * BOTH SEPARATIONS, NOT THE FAILING ONE. A card can pass elevation and fail
 * readability; a candidate that answers readability alone can walk the fill
 * back onto the card. Every candidate is asked both questions.
 *
 * NEAREST FIRST, AND AWAY FROM THE CARD ON A TIE. The repair is a rewrite of
 * somebody's window, so the smallest one that works is the right one; when two
 * are equally near, the one that moves the ink AWAY from the card's own
 * lightness is the one that also helps the fill.
 *
 * AND ONLY WHAT A SCREEN CAN SHOW. A candidate a browser would gamut-map is one
 * whose measured ratio is about a colour nobody will see — see
 * `paintsAsMeasured`. Refusing those costs some repairs (they become
 * `stranded`, which is reported rather than hidden) and buys the only thing
 * that makes the measurement worth anything: the emitted colour is the painted
 * colour. It is also what stops the search finding a degenerate answer, since
 * "drive the ink to black" is always available and always out of gamut at the
 * chroma the vocabulary carries.
 *
 * A FIXED POINT WHEN THE SHIPPED INK ALREADY HOLDS — the first line, before any
 * parsing. That is what makes `compileComposition` byte-identical for every
 * Look this build ships, and it is the property worth testing hardest.
 */
export function repairInk(ink: string, card: string, floor: number): InkRepair {
  const clears = (value: string) => {
    const { elevation, readability } = measureTint(value, card, floor);
    return elevation >= TINT_ELEVATION && readability >= TINT_READABLE;
  };
  if (clears(ink)) return { outcome: "holds", ink };

  const parsed = INK_OKLCH.exec(ink.trim());
  if (!parsed) return { outcome: "stranded", ink };
  const lightness = Number(parsed[1]);
  if (!Number.isFinite(lightness)) return { outcome: "stranded", ink };

  const away = toOklab(card).L <= lightness ? 1 : -1;
  const steps = Math.round(1 / INK_STEP);
  for (let step = 1; step <= steps; step += 1) {
    for (const direction of [away, -away]) {
      const candidate = lightness + direction * step * INK_STEP;
      if (candidate < 0 || candidate > 1) continue;
      const moved = `oklch(${candidate.toFixed(3)} ${parsed[2]} ${parsed[3]})`;
      if (!paintsAsMeasured(toOklab(moved))) continue;
      if (clears(moved)) return { outcome: "repaired", ink: moved, moved: deltaEOk(toOklab(ink), toOklab(moved)) };
    }
  }
  return { outcome: "stranded", ink };
}

/** What a card costs the tints, once the repair has done what it can. */
export type TintCost = {
  /** The WORST `text-<tone>` on `.tint-<tone>` ratio this card yields AFTER the
   *  repair — the number a reader actually meets, not the one they would have
   *  met without it. */
  readability: number;
  /** Which tone that number belongs to. */
  tone: TintTone;
  /** Tones no lightness can rescue. These are REPORTED and left alone. */
  stranded: readonly TintTone[];
};

/**
 * ONE CARD, ALL THREE TONES — the number a report shows and the list it names.
 *
 * It measures the REPAIRED ink on purpose. A row that showed the unrepaired
 * ratio would be saying a colour is unreadable while the window paints it
 * readably; the only honest number for a surface to display is the one it is
 * about to paint. Which means a red number here and a `stranded` entry are the
 * same event seen twice, and that is the point: the repair's failure is the
 * only thing a person has to know about.
 */
export function tintCost(card: string, ink: Record<TintTone, string>, floor: number): TintCost {
  let readability = Number.POSITIVE_INFINITY;
  let tone: TintTone = TINT_TONES[0];
  const stranded: TintTone[] = [];
  for (const candidate of TINT_TONES) {
    const repair = repairInk(ink[candidate], card, floor);
    if (repair.outcome === "stranded") stranded.push(candidate);
    const measured = measureTint(repair.ink, card, floor).readability;
    if (measured < readability) {
      readability = measured;
      tone = candidate;
    }
  }
  return { readability, tone, stranded };
}
