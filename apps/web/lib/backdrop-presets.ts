/**
 * BACKDROP PRESETS — the crafted scenes, and the grammar for hand-rolled ones.
 *
 * Two things live here because they answer the same question in two voices:
 * "what CSS does #app-backdrop paint?" The presets answer it with authored
 * mesh compositions; composeGradient answers it with whatever the editor's
 * colour rows currently say.
 *
 * WHY THE SCENES LOOK THE WAY THEY DO. Every preset is the same recipe: a
 * flat linear wash for the base, then three or four soft radial blobs dropped
 * on top at fixed corners. That shape is what reads as a "mesh" wallpaper
 * without a mesh renderer — the blobs bleed into `transparent` over half the
 * viewport, so their edges never resolve into visible circles. Colours are
 * oklch() so the light and dark halves of one scene can share a hue and differ
 * only in lightness/chroma, and so chroma stays PERCEPTUALLY restrained: the app's
 * canvas frosts over this at 30-70% opacity, and a scene with saturated
 * midtones turns body text into a legibility problem. Light halves sit near
 * L 0.9+ with chroma under ~0.08; dark halves near L 0.2-0.3 with chroma
 * under ~0.09. That ceiling is the whole design constraint.
 *
 * WHY VALUES ARE STRINGS AND NOT A COLOUR MODEL. lib/backdrop.ts stores the
 * RESOLVED CSS at choice time so the pre-paint init script needs no preset
 * table — which means whatever we hand setBackdrop has to be a finished
 * `background-image` value already. Building one from a structured model here
 * would just be a compiler nobody else can call. Every string below must pass
 * isGradientValue (no `;`, no `}`, no `url(`) — backdrop-presets.test.ts
 * asserts that for both halves of every preset, because a value that fails
 * the gate is silently dropped by the store rather than rejected loudly.
 *
 * THE CUSTOM FORMAT IS DELIBERATELY DULL. The editor must reopen populated
 * from whatever the store holds, and the only value it is ever asked to
 * reopen is one it wrote itself. So the generated form is a single gradient
 * function with explicit, evenly-spaced stop percentages and nothing else —
 * regular enough that parseGradient is a regex, and round-tripping is a test
 * rather than a hope. Anything unparseable (a preset, a hand-edited value)
 * comes back null and the editor opens on its default instead.
 */

export type BackdropPreset = {
  id: string;
  label: string;
  /** CSS `background-image` for the light scheme. */
  light: string;
  /** CSS `background-image` for the dark scheme. */
  dark: string;
};

export const BACKDROP_PRESETS: readonly BackdropPreset[] = [
  {
    id: "aurora",
    label: "Aurora",
    light:
      "radial-gradient(at 14% 18%, oklch(0.93 0.07 165) 0px, transparent 55%), radial-gradient(at 84% 12%, oklch(0.92 0.06 255) 0px, transparent 52%), radial-gradient(at 62% 88%, oklch(0.94 0.05 300) 0px, transparent 55%), linear-gradient(165deg, oklch(0.98 0.012 220), oklch(0.95 0.025 260))",
    dark: "radial-gradient(at 14% 18%, oklch(0.42 0.09 165) 0px, transparent 55%), radial-gradient(at 84% 12%, oklch(0.36 0.09 255) 0px, transparent 52%), radial-gradient(at 62% 88%, oklch(0.34 0.08 300) 0px, transparent 55%), linear-gradient(165deg, oklch(0.19 0.02 250), oklch(0.15 0.02 265))",
  },
  {
    id: "dusk",
    label: "Dusk",
    light:
      "radial-gradient(at 20% 82%, oklch(0.93 0.06 30) 0px, transparent 55%), radial-gradient(at 78% 20%, oklch(0.91 0.06 300) 0px, transparent 55%), radial-gradient(at 50% 50%, oklch(0.95 0.04 350) 0px, transparent 60%), linear-gradient(180deg, oklch(0.97 0.02 285), oklch(0.94 0.03 20))",
    dark: "radial-gradient(at 20% 82%, oklch(0.38 0.08 30) 0px, transparent 55%), radial-gradient(at 78% 20%, oklch(0.33 0.08 300) 0px, transparent 55%), radial-gradient(at 50% 50%, oklch(0.30 0.06 350) 0px, transparent 60%), linear-gradient(180deg, oklch(0.17 0.025 285), oklch(0.14 0.02 20))",
  },
  {
    id: "deep-sea",
    label: "Deep Sea",
    light:
      "radial-gradient(at 12% 24%, oklch(0.92 0.06 210) 0px, transparent 55%), radial-gradient(at 88% 70%, oklch(0.93 0.05 190) 0px, transparent 55%), radial-gradient(at 55% 4%, oklch(0.95 0.04 240) 0px, transparent 50%), linear-gradient(175deg, oklch(0.97 0.015 215), oklch(0.93 0.03 225))",
    dark: "radial-gradient(at 12% 24%, oklch(0.34 0.08 215) 0px, transparent 55%), radial-gradient(at 88% 70%, oklch(0.31 0.07 190) 0px, transparent 55%), radial-gradient(at 55% 4%, oklch(0.28 0.07 245) 0px, transparent 50%), linear-gradient(175deg, oklch(0.15 0.025 225), oklch(0.11 0.02 235))",
  },
  {
    id: "nebula",
    label: "Nebula",
    light:
      "radial-gradient(at 24% 14%, oklch(0.92 0.07 320) 0px, transparent 52%), radial-gradient(at 80% 34%, oklch(0.92 0.06 265) 0px, transparent 52%), radial-gradient(at 46% 92%, oklch(0.93 0.05 350) 0px, transparent 55%), linear-gradient(150deg, oklch(0.97 0.02 300), oklch(0.94 0.03 270))",
    dark: "radial-gradient(at 24% 14%, oklch(0.36 0.09 320) 0px, transparent 52%), radial-gradient(at 80% 34%, oklch(0.32 0.09 265) 0px, transparent 52%), radial-gradient(at 46% 92%, oklch(0.29 0.07 350) 0px, transparent 55%), linear-gradient(150deg, oklch(0.16 0.03 300), oklch(0.12 0.025 275))",
  },
  {
    id: "sunrise",
    label: "Sunrise",
    light:
      "radial-gradient(at 50% 96%, oklch(0.95 0.07 70) 0px, transparent 58%), radial-gradient(at 16% 26%, oklch(0.93 0.05 25) 0px, transparent 52%), radial-gradient(at 86% 18%, oklch(0.93 0.05 300) 0px, transparent 52%), linear-gradient(0deg, oklch(0.97 0.03 60), oklch(0.95 0.025 280))",
    dark: "radial-gradient(at 50% 96%, oklch(0.44 0.09 70) 0px, transparent 58%), radial-gradient(at 16% 26%, oklch(0.34 0.08 25) 0px, transparent 52%), radial-gradient(at 86% 18%, oklch(0.30 0.07 300) 0px, transparent 52%), linear-gradient(0deg, oklch(0.20 0.03 55), oklch(0.13 0.02 285))",
  },
  {
    id: "meadow",
    label: "Meadow",
    light:
      "radial-gradient(at 18% 76%, oklch(0.93 0.07 140) 0px, transparent 55%), radial-gradient(at 76% 84%, oklch(0.94 0.06 110) 0px, transparent 52%), radial-gradient(at 60% 8%, oklch(0.95 0.04 230) 0px, transparent 55%), linear-gradient(200deg, oklch(0.98 0.015 220), oklch(0.95 0.03 135))",
    dark: "radial-gradient(at 18% 76%, oklch(0.38 0.08 140) 0px, transparent 55%), radial-gradient(at 76% 84%, oklch(0.34 0.07 110) 0px, transparent 52%), radial-gradient(at 60% 8%, oklch(0.30 0.06 230) 0px, transparent 55%), linear-gradient(200deg, oklch(0.15 0.02 225), oklch(0.13 0.025 140))",
  },
  {
    id: "glacier",
    label: "Glacier",
    light:
      "radial-gradient(at 10% 10%, oklch(0.96 0.04 220) 0px, transparent 55%), radial-gradient(at 90% 40%, oklch(0.95 0.035 195) 0px, transparent 52%), radial-gradient(at 40% 95%, oklch(0.96 0.03 260) 0px, transparent 55%), linear-gradient(155deg, oklch(0.99 0.008 220), oklch(0.96 0.02 210))",
    dark: "radial-gradient(at 10% 10%, oklch(0.36 0.05 220) 0px, transparent 55%), radial-gradient(at 90% 40%, oklch(0.33 0.05 195) 0px, transparent 52%), radial-gradient(at 40% 95%, oklch(0.30 0.045 260) 0px, transparent 55%), linear-gradient(155deg, oklch(0.18 0.015 220), oklch(0.14 0.015 215))",
  },
  {
    id: "sandstone",
    label: "Sandstone",
    light:
      "radial-gradient(at 22% 20%, oklch(0.94 0.05 60) 0px, transparent 55%), radial-gradient(at 82% 62%, oklch(0.93 0.05 35) 0px, transparent 55%), radial-gradient(at 48% 96%, oklch(0.95 0.035 90) 0px, transparent 52%), linear-gradient(170deg, oklch(0.98 0.015 75), oklch(0.94 0.03 45))",
    dark: "radial-gradient(at 22% 20%, oklch(0.38 0.055 60) 0px, transparent 55%), radial-gradient(at 82% 62%, oklch(0.34 0.06 35) 0px, transparent 55%), radial-gradient(at 48% 96%, oklch(0.31 0.045 90) 0px, transparent 52%), linear-gradient(170deg, oklch(0.17 0.02 70), oklch(0.13 0.02 45))",
  },
  {
    id: "orchid",
    label: "Orchid",
    light:
      "radial-gradient(at 16% 30%, oklch(0.93 0.06 340) 0px, transparent 55%), radial-gradient(at 84% 24%, oklch(0.93 0.05 285) 0px, transparent 52%), radial-gradient(at 52% 90%, oklch(0.95 0.045 20) 0px, transparent 55%), linear-gradient(145deg, oklch(0.98 0.015 320), oklch(0.95 0.03 300))",
    dark: "radial-gradient(at 16% 30%, oklch(0.36 0.08 340) 0px, transparent 55%), radial-gradient(at 84% 24%, oklch(0.32 0.075 285) 0px, transparent 52%), radial-gradient(at 52% 90%, oklch(0.29 0.06 20) 0px, transparent 55%), linear-gradient(145deg, oklch(0.16 0.025 325), oklch(0.13 0.02 300))",
  },
  {
    id: "ember",
    label: "Ember",
    light:
      "radial-gradient(at 26% 84%, oklch(0.93 0.07 40) 0px, transparent 55%), radial-gradient(at 80% 76%, oklch(0.94 0.055 15) 0px, transparent 52%), radial-gradient(at 56% 10%, oklch(0.95 0.03 30) 0px, transparent 58%), linear-gradient(0deg, oklch(0.95 0.035 35), oklch(0.98 0.01 60))",
    dark: "radial-gradient(at 26% 84%, oklch(0.42 0.09 40) 0px, transparent 55%), radial-gradient(at 80% 76%, oklch(0.35 0.085 15) 0px, transparent 52%), radial-gradient(at 56% 10%, oklch(0.26 0.05 30) 0px, transparent 58%), linear-gradient(0deg, oklch(0.19 0.03 35), oklch(0.11 0.015 45))",
  },
  {
    id: "moonlit",
    label: "Moonlit",
    light:
      "radial-gradient(at 72% 14%, oklch(0.96 0.03 250) 0px, transparent 55%), radial-gradient(at 18% 58%, oklch(0.94 0.035 275) 0px, transparent 55%), radial-gradient(at 60% 98%, oklch(0.95 0.025 230) 0px, transparent 52%), linear-gradient(190deg, oklch(0.98 0.01 260), oklch(0.94 0.02 255))",
    dark: "radial-gradient(at 72% 14%, oklch(0.34 0.045 250) 0px, transparent 55%), radial-gradient(at 18% 58%, oklch(0.28 0.05 275) 0px, transparent 55%), radial-gradient(at 60% 98%, oklch(0.25 0.04 230) 0px, transparent 52%), linear-gradient(190deg, oklch(0.14 0.015 258), oklch(0.10 0.012 255))",
  },
] as const;

export function backdropPresetById(id: string): BackdropPreset | undefined {
  return BACKDROP_PRESETS.find((preset) => preset.id === id);
}

/* ------------------------------------------------------------------ custom */

export type CustomGradientType = "linear" | "radial";

/** What the editor holds, per colour scheme. Stops are colours only — their
 *  positions are derived (evenly spaced) so there is one fewer control to
 *  operate and one fewer thing for the parser to disagree about. */
export type CustomGradientSpec = {
  type: CustomGradientType;
  /** Degrees, only meaningful when `type` is "linear". */
  angle: number;
  /** 2-4 CSS colours, in paint order. `<input type="color">` gives hex. */
  stops: string[];
};

export const MIN_GRADIENT_STOPS = 2;
export const MAX_GRADIENT_STOPS = 4;

export const DEFAULT_CUSTOM_GRADIENT: { light: CustomGradientSpec; dark: CustomGradientSpec } = {
  light: { type: "linear", angle: 160, stops: ["#eef2ff", "#fce7f3"] },
  dark: { type: "linear", angle: 160, stops: ["#1e1b3a", "#2d1b2e"] },
};

function clampAngle(angle: number): number {
  if (!Number.isFinite(angle)) return 0;
  // Wrap rather than clamp: 370deg and 10deg are the same picture, and a
  // slider that stalls at its end feels broken.
  return ((Math.round(angle) % 360) + 360) % 360;
}

/**
 * The one place a spec becomes CSS. Stops are emitted with explicit, evenly
 * spaced percentages — redundant for the browser, load-bearing for us: it
 * makes every generated value the same shape, which is what lets parse below
 * be trivial and the round-trip test be exact.
 */
export function composeGradient(spec: CustomGradientSpec): string {
  const stops = spec.stops.slice(0, MAX_GRADIENT_STOPS);
  while (stops.length < MIN_GRADIENT_STOPS) stops.push(stops[stops.length - 1] ?? "#000000");
  const last = stops.length - 1;
  const list = stops.map((color, index) => `${color} ${Math.round((index / last) * 100)}%`).join(", ");
  return spec.type === "radial"
    ? `radial-gradient(circle at 50% 50%, ${list})`
    : `linear-gradient(${clampAngle(spec.angle)}deg, ${list})`;
}

const LINEAR = /^linear-gradient\((\d{1,3})deg, (.+)\)$/;
const RADIAL = /^radial-gradient\(circle at 50% 50%, (.+)\)$/;
// Hex or a bare keyword only — the stop forms `<input type="color">` and the
// editor's defaults can actually produce. Comma-bearing functional colours
// (rgb(), oklch()) are deliberately NOT recognised: splitting the stop list on
// commas would shred them, and pretending otherwise would parse them wrong
// rather than refuse them.
const STOP = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]+) \d{1,3}%$/;

/**
 * The inverse of composeGradient, and ONLY of composeGradient: it recognises
 * our own generated shape and nothing else. A preset value, a hand-edited
 * one, or anything with a stop it cannot name returns null — the editor then
 * opens on DEFAULT_CUSTOM_GRADIENT rather than on a half-understood parse,
 * which is the honest failure. Never throws.
 */
export function parseGradient(value: string): CustomGradientSpec | null {
  const trimmed = value.trim();
  const radial = RADIAL.exec(trimmed);
  const linear = radial ? null : LINEAR.exec(trimmed);
  const body = radial?.[1] ?? linear?.[2];
  if (body === undefined) return null;
  const stops: string[] = [];
  for (const piece of body.split(",")) {
    const match = STOP.exec(piece.trim());
    if (!match) return null;
    stops.push(match[1]);
  }
  if (stops.length < MIN_GRADIENT_STOPS || stops.length > MAX_GRADIENT_STOPS) return null;
  if (radial) return { type: "radial", angle: DEFAULT_CUSTOM_GRADIENT.light.angle, stops };
  return { type: "linear", angle: clampAngle(Number(linear?.[1])), stops };
}
