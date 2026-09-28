
import { cssColorToHex } from "./theme-palettes";
import { contrastRatio, parseVsCodeColor } from "./vscode-theme-import";

export type Oklab = { L: number; a: number; b: number };
type Rgb = { r: number; g: number; b: number };

export const TINT_ELEVATION = 1.075;

export const TINT_READABLE = 4.5;

export const TONE_JND = 0.02;

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

export function paintsAsMeasured(value: Oklab, tolerance = TONE_JND): boolean {
  return deltaEOk(value, rgbToOklab(oklabToRgb(value))) <= tolerance;
}

export function deltaEOk(first: Oklab, second: Oklab): number {
  return Math.hypot(first.L - second.L, first.a - second.a, first.b - second.b);
}

export function tintOf(ink: string, card: string, floor: number): Oklab {
  const a = toOklab(ink);
  const b = toOklab(card);
  return {
    L: a.L * floor + b.L * (1 - floor),
    a: a.a * floor + b.a * (1 - floor),
    b: a.b * floor + b.b * (1 - floor),
  };
}

export function measureTint(ink: string, card: string, floor: number): { elevation: number; readability: number } {
  const fill = oklabToRgb(tintOf(ink, card, floor));
  return {
    elevation: contrastRatio(fill, oklabToRgb(toOklab(card))),
    readability: contrastRatio(oklabToRgb(toOklab(ink)), fill),
  };
}

export function toneSeparation(first: string, second: string, floor: number): number {
  return floor * deltaEOk(toOklab(first), toOklab(second));
}

export const TINT_TONES = ["success", "warning", "destructive"] as const;
export type TintTone = (typeof TINT_TONES)[number];

export type TintScheme = "light" | "dark";

export const TINT_FLOOR = 0.12;

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

export type InkRepair =
  | { outcome: "holds"; ink: string }
  | { outcome: "repaired"; ink: string; moved: number }
  | { outcome: "stranded"; ink: string };

const INK_OKLCH = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+(-?[\d.]+)\s*\)$/;

const INK_STEP = 0.001;

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

export type TintCost = {
  readability: number;
  tone: TintTone;
  stranded: readonly TintTone[];
};

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
