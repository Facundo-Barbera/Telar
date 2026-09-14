/**
 * A THEME FROM THE BACKDROP — the picture you chose, wearing the app.
 *
 * The whole feature is one idea: if someone put a photograph under the app,
 * the app's surfaces should agree with it. Not match it — AGREE. Sampling the
 * literal average colour of a photo gives mud; sampling its most saturated
 * pixel gives a highlighter. What actually reads as "from this image" is its
 * dominant HUE, applied at Telar's own restrained chroma.
 *
 * SO THE EXTRACTION IS A HUE HISTOGRAM, NOT A COLOUR CLUSTERER. Twelve 30°
 * buckets, each pixel weighted by its saturation, and three whole families of
 * pixel skipped outright:
 *   - near-grey  — carries no hue worth trusting; a rounding error decides it
 *   - near-black — the shadows of every photograph, and hue there is noise
 *   - near-white — sky, paper, blown highlights; same story
 * A photo that is ALL of those (a grey building, a snowfield) yields nothing,
 * and yielding nothing is the correct answer: themeFromPalette falls back to
 * untouched Telar rather than inventing a tint from noise.
 *
 * WHY BUCKETS AND THEN A CIRCULAR MEAN: buckets decide WHICH hue family won
 * (cheap, robust to outliers), the circular mean inside the winning bucket
 * decides WHERE in it (so a photo of the sea gets its own blue, not "bucket 8
 * is 255°"). Circular because hue is an angle — averaging 350° and 10° must
 * give 0°, not 180°.
 *
 * THE DERIVATION KEEPS TELAR'S LIGHTNESS SPINE. Every contrast claim the app
 * makes is a claim about L, so the halves here are literal copies of
 * TELAR_LIGHT / TELAR_DARK with only C and H rewritten — same maths as the
 * built-in themes' tinted halves (theme-palettes.ts), which are module-private
 * there and so cannot be called from here; the weights below mirror theirs so
 * an image theme sits in the same family as Ember and Tide rather than beside
 * it. Anything that does not parse as `oklch(L C H)` — the dark half's
 * translucent border — is copied through untouched.
 */

import { cssColorToHex, TELAR_DARK, TELAR_LIGHT, THEME_TOKENS, type ThemeDefinition, type ThemeHalf, type ThemeToken } from "./theme-palettes";

export type Rgb = { r: number; g: number; b: number };

/** One extracted hue family. `chroma` is the bucket's mean HSL saturation
 *  (0–1) — a measure of how COLOURFUL the family was, not a CSS chroma;
 *  themeFromPalette maps it onto Telar's much narrower tint range. */
export type PaletteColor = { hue: number; chroma: number; weight: number };

export const HUE_BUCKETS = 12;

/** Below this saturation a pixel's hue is a rounding artefact. */
const MIN_SATURATION = 0.15;
/** The shadows and the blown highlights of every photograph. */
const MIN_LIGHTNESS = 0.08;
const MAX_LIGHTNESS = 0.95;
/** Nearly transparent pixels contribute nothing a viewer would see. */
const MIN_ALPHA = 8;

/** HSL hue (0–360) and saturation/lightness (0–1) from 8-bit sRGB. Plain HSL,
 *  not OKLCH: the extraction only needs to rank hue families, and HSL is
 *  cheap enough to run over tens of thousands of pixels. */
export function rgbToHsl(r: number, g: number, b: number): { hue: number; saturation: number; lightness: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const lightness = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return { hue: 0, saturation: 0, lightness };
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue: number;
  if (max === rn) hue = ((gn - bn) / delta) % 6;
  else if (max === gn) hue = (bn - rn) / delta + 2;
  else hue = (rn - gn) / delta + 4;
  hue *= 60;
  if (hue < 0) hue += 360;
  return { hue, saturation: Math.min(1, saturation), lightness };
}

function* eachPixel(pixels: Uint8ClampedArray | readonly Rgb[]): Generator<{ r: number; g: number; b: number; a: number }> {
  if (ArrayBuffer.isView(pixels)) {
    for (let i = 0; i + 3 < pixels.length; i += 4) {
      yield { r: pixels[i] ?? 0, g: pixels[i + 1] ?? 0, b: pixels[i + 2] ?? 0, a: pixels[i + 3] ?? 255 };
    }
    return;
  }
  for (const pixel of pixels) yield { r: pixel.r, g: pixel.g, b: pixel.b, a: 255 };
}

/**
 * The dominant hue families, strongest first. Accepts an ImageData `data`
 * array (RGBA quads) or plain {r,g,b} records so tests can hand it four
 * pixels instead of a canvas.
 *
 * Returns [] when nothing survived the skips — a grey or monochrome image
 * genuinely has no hue, and a caller inventing one would be lying about the
 * picture.
 */
export function dominantHues(pixels: Uint8ClampedArray | readonly Rgb[], options?: { buckets?: number; count?: number }): PaletteColor[] {
  const buckets = Math.max(1, Math.round(options?.buckets ?? HUE_BUCKETS));
  const count = Math.max(1, Math.round(options?.count ?? 3));
  const width = 360 / buckets;
  // Per bucket: total weight, and the weighted unit-vector sum whose angle IS
  // the circular mean hue.
  const totals = new Float64Array(buckets);
  const xs = new Float64Array(buckets);
  const ys = new Float64Array(buckets);
  const saturations = new Float64Array(buckets);

  for (const { r, g, b, a } of eachPixel(pixels)) {
    if (a < MIN_ALPHA) continue;
    const { hue, saturation, lightness } = rgbToHsl(r, g, b);
    if (saturation < MIN_SATURATION) continue;
    if (lightness < MIN_LIGHTNESS || lightness > MAX_LIGHTNESS) continue;
    const index = Math.min(buckets - 1, Math.floor(hue / width));
    const weight = saturation; // × one pixel of area
    totals[index] += weight;
    saturations[index] += saturation * weight;
    const radians = (hue * Math.PI) / 180;
    xs[index] += Math.cos(radians) * weight;
    ys[index] += Math.sin(radians) * weight;
  }

  const found: PaletteColor[] = [];
  for (let index = 0; index < buckets; index += 1) {
    const total = totals[index] ?? 0;
    if (total <= 0) continue;
    let hue = (Math.atan2(ys[index] ?? 0, xs[index] ?? 0) * 180) / Math.PI;
    if (hue < 0) hue += 360;
    found.push({ hue, chroma: (saturations[index] ?? 0) / total, weight: total });
  }
  found.sort((a, b) => b.weight - a.weight);
  return found.slice(0, count);
}

// ── Deriving the theme ──────────────────────────────────────────────────────

/**
 * How much chroma each token gets, as a multiple of the theme's tint. Copied
 * in spirit from theme-palettes.ts's tinted halves: fills carry the tint,
 * text carries a whisper of it, and the rail sits between. See the header for
 * why these are duplicated rather than imported.
 */
const LIGHT_WEIGHTS: Record<ThemeToken, number> = {
  background: 0.5,
  foreground: 0.8,
  card: 0.25,
  "card-foreground": 0.8,
  popover: 0.25,
  "popover-foreground": 0.8,
  secondary: 1,
  "secondary-foreground": 0.8,
  muted: 0.9,
  "muted-foreground": 1.2,
  accent: 1,
  "accent-foreground": 0.8,
  border: 1.1,
  input: 1.2,
  sidebar: 0.9,
  "sidebar-accent": 1.1,
};

const DARK_WEIGHTS: Record<ThemeToken, number> = {
  background: 1,
  foreground: 0.35,
  card: 1.1,
  "card-foreground": 0.35,
  popover: 1.1,
  "popover-foreground": 0.35,
  secondary: 1.2,
  "secondary-foreground": 0.35,
  muted: 1.2,
  "muted-foreground": 0.8,
  accent: 1.3,
  "accent-foreground": 0.35,
  border: 1,
  input: 0.8,
  sidebar: 1,
  "sidebar-accent": 1.2,
};

/** The tint band. The floor keeps a barely-coloured photo from producing a
 *  theme indistinguishable from Telar; the ceiling is the real point — past
 *  it a workspace becomes a poster. */
const MIN_TINT = 0.008;
const MAX_TINT = 0.022;

/** Saturation (0–1) → the theme's base OKLCH chroma. Deliberately compressive:
 *  a neon photo and a merely colourful one land close together, because the
 *  difference between them belongs in the backdrop, not the chrome. */
export function tintForSaturation(saturation: number): number {
  const s = Number.isFinite(saturation) ? Math.min(1, Math.max(0, saturation)) : 0;
  return Math.min(MAX_TINT, MIN_TINT + s * (MAX_TINT - MIN_TINT));
}

const OKLCH = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+(-?[\d.]+)\s*\)$/;

/** One token, re-hued. The lightness string is carried across VERBATIM — it
 *  is the contrast contract, and re-formatting a number is a chance to drift
 *  it. A value that is not a plain three-part oklch (the dark border's
 *  `oklch(1 0 0 / 10%)`) is left exactly as it was. */
function retint(value: string, hue: number, chroma: number): string {
  const parsed = OKLCH.exec(value);
  if (!parsed) return value;
  return `oklch(${parsed[1]} ${chroma.toFixed(4)} ${hue.toFixed(1)})`;
}

function tintHalf(base: ThemeHalf, weights: Record<ThemeToken, number>, hue: number, tint: number, secondary?: { hue: number; tint: number }): ThemeHalf {
  const half = {} as ThemeHalf;
  for (const token of THEME_TOKENS) {
    // The chips and the rail's hover are where a second hue can sing without
    // arguing with the canvas — everything else stays on the dominant one.
    const useSecondary = secondary && (token === "secondary" || token === "sidebar-accent");
    const h = useSecondary ? secondary.hue : hue;
    const t = useSecondary ? secondary.tint : tint;
    half[token] = retint(base[token], h, t * weights[token]);
  }
  return half;
}

/** A second hue only earns the chips if it is genuinely PRESENT (a quarter of
 *  the dominant family's weight) and genuinely DIFFERENT (30° away — inside
 *  that it is the same colour and would read as a mistake). */
const SECONDARY_MIN_SHARE = 0.25;
const SECONDARY_MIN_DISTANCE = 30;

function hueDistance(a: number, b: number): number {
  const raw = Math.abs(a - b) % 360;
  return raw > 180 ? 360 - raw : raw;
}

export function pickSecondary(colors: readonly PaletteColor[]): PaletteColor | undefined {
  const primary = colors[0];
  if (!primary) return undefined;
  return colors
    .slice(1)
    .find((color) => color.weight >= primary.weight * SECONDARY_MIN_SHARE && hueDistance(color.hue, primary.hue) >= SECONDARY_MIN_DISTANCE);
}

/**
 * The palette as a wearable theme. Id-less on purpose: the caller mints one
 * (`custom-<time>`) exactly as the import and duplicate paths do, so every
 * custom theme's identity is minted in one place.
 *
 * An empty palette returns Telar itself — a grey photograph has no opinion
 * about your chrome, and pretending otherwise produces a randomly tinted app.
 */
export function themeFromPalette(colors: readonly PaletteColor[]): Omit<ThemeDefinition, "id"> {
  const primary = colors[0];
  if (!primary) return { label: "From image", light: { ...TELAR_LIGHT }, dark: { ...TELAR_DARK } };
  const tint = tintForSaturation(primary.chroma);
  const second = pickSecondary(colors);
  const secondary = second ? { hue: second.hue, tint: tintForSaturation(second.chroma) * 1.2 } : undefined;
  return {
    label: "From image",
    light: tintHalf(TELAR_LIGHT, LIGHT_WEIGHTS, primary.hue, tint, secondary),
    dark: tintHalf(TELAR_DARK, DARK_WEIGHTS, primary.hue, tint, secondary),
  };
}

/** The whole pipeline, for the picker: pixels in, theme out. */
export function themeFromPixels(pixels: Uint8ClampedArray | readonly Rgb[]): Omit<ThemeDefinition, "id"> {
  return themeFromPalette(dominantHues(pixels));
}

/* ── The composer's base, through the same engine ────────────────────────── */

/**
 * ONE COLOUR BECOMES SIXTEEN — the derivation the composer is built on (#471).
 *
 * A composition state is a BASE colour and a stack of layers; the surface
 * tokens are derived from that base rather than stored, which is what makes
 * "the composer IS the theme" true rather than a slogan. This is the same
 * engine a photograph goes through, one step shorter: a picture has to be
 * reduced to a hue first, and a base colour already is one.
 *
 * WHICH MEANS THE BASE IS A HUE, NOT A CANVAS COLOUR. Telar's lightness spine
 * is kept underneath and only C and H are rewritten, so every base yields a
 * palette whose text sits readably on its surfaces — you cannot pick a canvas
 * your foreground disappears into, because the foreground moves with it. That
 * is the property the contrast test pins, and it is the reason the owner asked
 * for this engine rather than "the base IS --background".
 *
 * A COLOURLESS BASE DERIVES TELAR ITSELF, by the same rule a grey photograph
 * does: under the extractor's own saturation floor there is no hue to trust,
 * and inventing one would tint the identity look faintly red on the strength of
 * a rounding error.
 */
export function halfFromBase(base: string, mode: "light" | "dark"): ThemeHalf {
  const neutral = mode === "light" ? TELAR_LIGHT : TELAR_DARK;
  const hex = cssColorToHex(base);
  const parsed = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
  if (!parsed) return { ...neutral };
  const [r, g, b] = [1, 2, 3].map((index) => parseInt(parsed[index]!, 16)) as [number, number, number];
  const { hue, saturation } = rgbToHsl(r, g, b);
  if (saturation < MIN_SATURATION) return { ...neutral };
  return tintHalf(neutral, mode === "light" ? LIGHT_WEIGHTS : DARK_WEIGHTS, hue, tintForSaturation(saturation));
}

/**
 * The palette a state actually paints: what the base derived, with whatever
 * somebody set by hand on top. The one place those two are combined, so nothing
 * can disagree about which wins — the hand does.
 */
export function halfFor(state: { base: string; overrides: Partial<ThemeHalf> }, mode: "light" | "dark"): ThemeHalf {
  const derived = halfFromBase(state.base, mode);
  for (const token of THEME_TOKENS) {
    const override = state.overrides[token];
    if (typeof override === "string" && override.length > 0) derived[token] = override;
  }
  return derived;
}

/**
 * THE PIXELS OF A DATA URL, downsampled — moved here from the backdrop tool so
 * the designer's picture attachments and the backdrop's "Take colours" read an
 * image exactly the same way. Two samplers would be two answers to "what
 * colours are in this?", and the pane has spent this rebuild deleting second
 * opinions.
 *
 * Downsampling is not an optimisation: averaging a 12-megapixel photo at full
 * size costs seconds and answers the same question a 96px edge does.
 */
/** The longest edge sampled — the value the backdrop tool has used all along. */
const SAMPLE_EDGE = 64;

export async function samplePixels(dataUrl: string): Promise<Uint8ClampedArray> {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  const longest = Math.max(image.naturalWidth || 1, image.naturalHeight || 1);
  const scale = Math.min(1, SAMPLE_EDGE / longest);
  const width = Math.max(1, Math.round((image.naturalWidth || 1) * scale));
  const height = Math.max(1, Math.round((image.naturalHeight || 1) * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("no 2d context");
  context.drawImage(image, 0, 0, width, height);
  return context.getImageData(0, 0, width, height).data;
}
