
import { cssColorToHex, TELAR_DARK, TELAR_LIGHT, THEME_TOKENS, type ThemeDefinition, type ThemeHalf, type ThemeToken } from "./theme-palettes";

export type Rgb = { r: number; g: number; b: number };

export type PaletteColor = { hue: number; chroma: number; weight: number };

const HUE_BUCKETS = 12;

const MIN_SATURATION = 0.15;
const MIN_LIGHTNESS = 0.08;
const MAX_LIGHTNESS = 0.95;
const MIN_ALPHA = 8;

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

export function dominantHues(pixels: Uint8ClampedArray | readonly Rgb[], options?: { buckets?: number; count?: number }): PaletteColor[] {
  const buckets = Math.max(1, Math.round(options?.buckets ?? HUE_BUCKETS));
  const count = Math.max(1, Math.round(options?.count ?? 3));
  const width = 360 / buckets;
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

const MIN_TINT = 0.008;
const MAX_TINT = 0.022;

export function tintForSaturation(saturation: number): number {
  const s = Number.isFinite(saturation) ? Math.min(1, Math.max(0, saturation)) : 0;
  return Math.min(MAX_TINT, MIN_TINT + s * (MAX_TINT - MIN_TINT));
}

const OKLCH = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+(-?[\d.]+)\s*\)$/;

function retint(value: string, hue: number, chroma: number): string {
  const parsed = OKLCH.exec(value);
  if (!parsed) return value;
  return `oklch(${parsed[1]} ${chroma.toFixed(4)} ${hue.toFixed(1)})`;
}

function tintHalf(base: ThemeHalf, weights: Record<ThemeToken, number>, hue: number, tint: number, secondary?: { hue: number; tint: number }): ThemeHalf {
  const half = {} as ThemeHalf;
  for (const token of THEME_TOKENS) {
    const useSecondary = secondary && (token === "secondary" || token === "sidebar-accent");
    const h = useSecondary ? secondary.hue : hue;
    const t = useSecondary ? secondary.tint : tint;
    half[token] = retint(base[token], h, t * weights[token]);
  }
  return half;
}

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

export function themeFromPixels(pixels: Uint8ClampedArray | readonly Rgb[]): Omit<ThemeDefinition, "id"> {
  return themeFromPalette(dominantHues(pixels));
}

function oklchHue(r: number, g: number, b: number): number {
  const linear = (channel: number) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  const [R, G, B] = [r, g, b].map((channel) => linear(channel / 255)) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const hue = (Math.atan2(bb, a) * 180) / Math.PI;
  return hue < 0 ? hue + 360 : hue;
}

export function halfFromBase(base: string, mode: "light" | "dark"): ThemeHalf {
  const neutral = mode === "light" ? TELAR_LIGHT : TELAR_DARK;
  const hex = cssColorToHex(base);
  const parsed = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
  if (!parsed) return { ...neutral };
  const [r, g, b] = [1, 2, 3].map((index) => parseInt(parsed[index]!, 16)) as [number, number, number];
  const { saturation } = rgbToHsl(r, g, b);
  if (saturation < MIN_SATURATION) return { ...neutral };
  return tintHalf(neutral, mode === "light" ? LIGHT_WEIGHTS : DARK_WEIGHTS, oklchHue(r, g, b), tintForSaturation(saturation));
}

export function halfFor(state: { base: string; overrides: Partial<ThemeHalf> }, mode: "light" | "dark"): ThemeHalf {
  const derived = halfFromBase(state.base, mode);
  for (const token of THEME_TOKENS) {
    const override = state.overrides[token];
    if (typeof override === "string" && override.length > 0) derived[token] = override;
  }
  return derived;
}
