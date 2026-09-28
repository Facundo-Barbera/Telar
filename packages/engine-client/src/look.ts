/* ═══════════════════════════════════════════════ the theme vocabulary ═══ */

/** The themable surface tokens, in the order the editor shows them. */
export const THEME_TOKENS = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "border",
  "input",
  "sidebar",
  "sidebar-accent",
] as const;
export type ThemeToken = (typeof THEME_TOKENS)[number];

/** One colour scheme's complete set of surface tokens. */
export type ThemeHalf = Record<ThemeToken, string>;

export const TELAR_LIGHT: ThemeHalf = {
  background: "oklch(0.975 0.002 286)",
  foreground: "oklch(0.274 0.006 286)",
  card: "oklch(1 0 0)",
  "card-foreground": "oklch(0.274 0.006 286)",
  popover: "oklch(1 0 0)",
  "popover-foreground": "oklch(0.274 0.006 286)",
  secondary: "oklch(0.943 0.002 286)",
  "secondary-foreground": "oklch(0.274 0.006 286)",
  muted: "oklch(0.952 0.001 286)",
  "muted-foreground": "oklch(0.525 0.016 286)",
  accent: "oklch(0.939 0.002 286)",
  "accent-foreground": "oklch(0.21 0.006 286)",
  border: "oklch(0.92 0.004 286)",
  input: "oklch(0.645 0.008 286)",
  sidebar: "oklch(0.955 0.002 286)",
  "sidebar-accent": "oklch(0.938 0.003 286)",
};

export const TELAR_DARK: ThemeHalf = {
  background: "oklch(0.145 0 0)",
  foreground: "oklch(0.97 0 0)",
  card: "oklch(0.2 0 0)",
  "card-foreground": "oklch(0.97 0 0)",
  popover: "oklch(0.225 0 0)",
  "popover-foreground": "oklch(0.97 0 0)",
  secondary: "oklch(0.265 0 0)",
  "secondary-foreground": "oklch(0.97 0 0)",
  muted: "oklch(0.265 0 0)",
  "muted-foreground": "oklch(0.708 0 0)",
  accent: "oklch(0.305 0 0)",
  "accent-foreground": "oklch(0.97 0 0)",
  border: "oklch(1 0 0 / 10%)",
  input: "oklch(0.53 0 0)",
  sidebar: "oklch(0.175 0 0)",
  "sidebar-accent": "oklch(0.265 0 0)",
};

/* ═══════════════════════════════════════ the accent and type vocabulary ═══ */

export const ACCENTS = ["indigo", "sky", "sea", "moss", "amber", "rose", "plum", "violet"] as const;
export type Accent = (typeof ACCENTS)[number];

export const APP_FONTS = [
  "geist",
  "inter",
  "plex-sans",
  "source-sans",
  "roboto",
  "noto-sans",
  "space-grotesk",
  "lato",
  "jetbrains",
  "plex-mono",
  "fira-code",
  "geist-mono",
  "source-code-pro",
  "roboto-mono",
  "cascadia-code",
  "system",
  "custom",
] as const;

export const SANS_FONTS = APP_FONTS;
export type SansFont = (typeof SANS_FONTS)[number];

export const MONO_FONTS = APP_FONTS;
export type MonoFont = (typeof MONO_FONTS)[number];

export const MONOSPACED_FONTS: ReadonlySet<string> = new Set([
  "jetbrains",
  "plex-mono",
  "fira-code",
  "geist-mono",
  "source-code-pro",
  "roboto-mono",
  "cascadia-code",
]);

export const MIN_FONT_SIZE = 13;
export const MAX_FONT_SIZE = 18;

export const MIN_MONO_FONT_SIZE = 11;
export const MAX_MONO_FONT_SIZE = 18;
export const DEFAULT_MONO_FONT_SIZE = 13;

export const MIN_TRANSLUCENCY = 0;
export const MAX_TRANSLUCENCY = 100;

export const DEPTHS = ["soft", "flat", "deep"] as const;
export type Depth = (typeof DEPTHS)[number];
export const DEFAULT_DEPTH: Depth = "soft";

export const DEFAULT_ACCENT: Accent = "indigo";
export const DEFAULT_SANS_FONT: SansFont = "geist";
export const DEFAULT_MONO_FONT: MonoFont = "geist";
export const DEFAULT_FONT_SIZE = 16;
export const DEFAULT_TRANSLUCENCY_LEVEL = 50;

/* ═══════════════════════════════════════ the backdrop vocabulary + gates ═══ */

export type BackdropFit = "cover" | "fill" | "tile";
export const BACKDROP_FITS = ["cover", "fill", "tile"] as const;

export const MAX_BACKDROP_BLUR = 40; // px
export const MAX_BACKDROP_DIM = 80; // %

export type BackdropLayers = { light: string; dark: string; size?: string; position?: string; repeat?: string };

export function isSafeColour(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[;{}<>]/.test(value);
}

export function isGradientValue(value: unknown): value is string {
  return typeof value === "string" && /gradient\(/.test(value) && !value.includes(";") && !value.includes("}") && !/url\s*\(/i.test(value);
}

export function isSceneValue(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes(";") || value.includes("}")) return false;
  return value
    .split(/url\(/i)
    .slice(1)
    .every((segment) => segment.startsWith('"data:image/'));
}

/* ════════════════════════════════════════════ the gradient vocabulary ═══ */

export type GradientType = "linear" | "radial";

export type GradientStop = {
  color: string;
  /** 0-100, where along the ramp this stop sits. */
  position: number;
  /** 0-100, this stop's own alpha. Zero is a real answer: it is how a
   *  gradient fades out into what is under it. */
  opacity: number;
};

export type CustomGradientSpec = {
  type: GradientType;
  /** Degrees, only meaningful when `type` is "linear". */
  angle: number;
  /** 0-100, the radial centre. Only meaningful when `type` is "radial". */
  centerX: number;
  centerY: number;
  /** MIN_GRADIENT_STOPS to MAX_GRADIENT_STOPS, in paint order. */
  stops: GradientStop[];
};

/** Two is the fewest that is a gradient at all; five is where a reader stops
 *  being able to say which stop they are dragging. */
export const MIN_GRADIENT_STOPS = 2;
export const MAX_GRADIENT_STOPS = 5;

export const GRADIENT_LIMITS = {
  center: { min: 0, max: 100 },
  position: { min: 0, max: 100 },
  opacity: { min: 0, max: 100 },
} as const;

/** What a fresh gradient opens on, per state: two stops, nothing clever. It is
 *  deliberately plain — the starter chips are where the tuned ones live. */
export const DEFAULT_GRADIENT_SPECS: Record<"light" | "dark", CustomGradientSpec> = {
  light: {
    type: "linear",
    angle: 160,
    centerX: 50,
    centerY: 50,
    stops: [
      { color: "#eef2ff", position: 0, opacity: 100 },
      { color: "#fce7f3", position: 100, opacity: 100 },
    ],
  },
  dark: {
    type: "linear",
    angle: 160,
    centerX: 50,
    centerY: 50,
    stops: [
      { color: "#1e1b3a", position: 0, opacity: 100 },
      { color: "#2d1b2e", position: 100, opacity: 100 },
    ],
  },
};

/** Wrap rather than clamp: 370deg and 10deg are the same picture, and a slider
 *  that stalls at its end feels broken. */
function wrapAngle(angle: unknown): number {
  if (typeof angle !== "number" || !Number.isFinite(angle)) return 0;
  return ((Math.round(angle) % 360) + 360) % 360;
}

function rgbHex(color: unknown): string | null {
  if (typeof color !== "string") return null;
  const match = /^#([0-9a-fA-F]{3,8})$/.exec(color.trim());
  const hex = match?.[1];
  if (hex === undefined) return null;
  if (hex.length === 3 || hex.length === 4) {
    return hex
      .slice(0, 3)
      .toLowerCase()
      .replace(/./g, (char) => char + char);
  }
  if (hex.length === 6 || hex.length === 8) return hex.slice(0, 6).toLowerCase();
  return null;
}

function alphaHex(opacity: number): string {
  return Math.round((Math.min(100, Math.max(0, opacity)) / 100) * 255)
    .toString(16)
    .padStart(2, "0");
}

/** One stop as CSS: the colour with its alpha written in, at full opacity the
 *  plain six digits so the value a reader sees stays legible. */
function stopColour(stop: GradientStop): string {
  const hex = rgbHex(stop.color);
  const opacity = clampTo(stop.opacity, GRADIENT_LIMITS.opacity, GRADIENT_LIMITS.opacity.max);
  // A keyword (or anything else a hand-edited value held) is passed through
  // rather than dropped: it paints, and refusing it would silently empty
  // somebody's gradient.
  if (hex === null) return typeof stop.color === "string" ? stop.color : "#000000";
  return opacity >= GRADIENT_LIMITS.opacity.max ? `#${hex}` : `#${hex}${alphaHex(opacity)}`;
}

export function composeGradient(spec: CustomGradientSpec): string {
  const stops = spec.stops.slice(0, MAX_GRADIENT_STOPS);
  while (stops.length < MIN_GRADIENT_STOPS) {
    stops.push(stops[stops.length - 1] ?? { color: "#000000", position: 100, opacity: 100 });
  }
  const list = stops.map((stop) => `${stopColour(stop)} ${clampTo(stop.position, GRADIENT_LIMITS.position, 0)}%`).join(", ");
  if (spec.type === "radial") {
    const x = clampTo(spec.centerX, GRADIENT_LIMITS.center, 50);
    const y = clampTo(spec.centerY, GRADIENT_LIMITS.center, 50);
    return `radial-gradient(circle at ${x}% ${y}%, ${list})`;
  }
  return `linear-gradient(${wrapAngle(spec.angle)}deg, ${list})`;
}

const LINEAR_CSS = /^linear-gradient\((\d{1,3})deg, (.+)\)$/;
const RADIAL_CSS = /^radial-gradient\(circle at (\d{1,3})% (\d{1,3})%, (.+)\)$/;
const STOP_CSS = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]+) (\d{1,3})%$/;

export function parseGradientCss(value: unknown): CustomGradientSpec | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const radial = RADIAL_CSS.exec(trimmed);
  const linear = radial ? null : LINEAR_CSS.exec(trimmed);
  const body = radial?.[3] ?? linear?.[2];
  if (body === undefined) return null;
  const stops: GradientStop[] = [];
  for (const piece of body.split(",")) {
    const match = STOP_CSS.exec(piece.trim());
    if (!match) return null;
    const hex = /^#[0-9a-fA-F]+$/.test(match[1]) ? match[1].slice(1) : null;
    const alpha = hex?.length === 4 ? parseInt(hex[3] + hex[3], 16) : hex?.length === 8 ? parseInt(hex.slice(6), 16) : 255;
    stops.push({
      color: rgbHex(match[1]) === null ? match[1] : `#${rgbHex(match[1])}`,
      position: clampTo(Number(match[2]), GRADIENT_LIMITS.position, 0),
      opacity: Math.round((alpha / 255) * 100),
    });
  }
  if (stops.length < MIN_GRADIENT_STOPS || stops.length > MAX_GRADIENT_STOPS) return null;
  if (radial) {
    return {
      type: "radial",
      angle: DEFAULT_GRADIENT_SPECS.light.angle,
      centerX: clampTo(Number(radial[1]), GRADIENT_LIMITS.center, 50),
      centerY: clampTo(Number(radial[2]), GRADIENT_LIMITS.center, 50),
      stops,
    };
  }
  return { type: "linear", angle: wrapAngle(Number(linear?.[1])), centerX: 50, centerY: 50, stops };
}

/** A stored spec, total. Undefined rather than defaulted, so a caller can tell
 *  "no spec here" (a v2 layer naming a preset) from "a spec that needed
 *  clamping". */
export function parseGradientSpec(value: unknown): CustomGradientSpec | undefined {
  if (!isRecord(value) || !Array.isArray(value.stops)) return undefined;
  const stops: GradientStop[] = [];
  for (const entry of value.stops.slice(0, MAX_GRADIENT_STOPS)) {
    if (!isRecord(entry) || !isSafeColour(entry.color)) continue;
    stops.push({
      color: entry.color,
      position: clampTo(entry.position, GRADIENT_LIMITS.position, 0),
      opacity: clampTo(entry.opacity, GRADIENT_LIMITS.opacity, GRADIENT_LIMITS.opacity.max),
    });
  }
  if (stops.length < MIN_GRADIENT_STOPS) return undefined;
  return {
    type: value.type === "radial" ? "radial" : "linear",
    angle: wrapAngle(value.angle),
    centerX: clampTo(value.centerX, GRADIENT_LIMITS.center, 50),
    centerY: clampTo(value.centerY, GRADIENT_LIMITS.center, 50),
    stops,
  };
}

/* ═══════════════════════════════════════════════ the scene vocabulary ═══ */

export type SceneImageLayer = {
  type: "image";
  id: string;
  /** 0-100, `background-position` X. */
  x: number;
  /** 0-100, `background-position` Y. */
  y: number;
  /** 10-200, `background-size` width percentage. */
  scale: number;
  /** 10-100; baked into the layer's own alpha, not applied in CSS. */
  opacity: number;
  tiled: boolean;
};

export type SceneGradientLayer = {
  type: "gradient";
  spec: CustomGradientSpec;
  /** 10-100, multiplied into the gradient's colours. */
  opacity: number;
};

export type SceneLayer = SceneImageLayer | SceneGradientLayer;

/** The composition: the stack, top layer first. Nothing is implied under it —
 *  a stack that does not end in a full-bleed gradient ends in transparency. */
export type Scene = { layers: SceneLayer[] };

/** Six is where a scene stops being a composition and starts being a collage
 *  nobody can see through — and six 1024px WebPs is already most of what a
 *  localStorage origin will hold. Images only: this cap is about the quota. */
export const MAX_SCENE_LAYERS = 6;

/** Gradient layers cost a few hundred bytes each, so their cap is about
 *  legibility rather than storage. */
export const MAX_SCENE_GRADIENT_LAYERS = 4;

export const SCENE_LIMITS = {
  x: { min: 0, max: 100 },
  y: { min: 0, max: 100 },
  scale: { min: 10, max: 200 },
  opacity: { min: 10, max: 100 },
} as const;

/** A fresh image layer sits centred at a size that reads as "an object on the
 *  backdrop" rather than as a replacement for it. */
export const DEFAULT_LAYER: Omit<SceneImageLayer, "id"> = { type: "image", x: 50, y: 50, scale: 60, opacity: 100, tiled: false };

export type ScenePresets = {
  /** The spec a starter id names, in one colour state; undefined when this
   *  build has no starter by that name. */
  expand: (id: string, mode: "light" | "dark") => CustomGradientSpec | undefined;
  /** The starter a layer naming nothing readable falls back to. */
  fallback: string;
};

/** Ids are generated, never typed — but they are also JSON keys sharing a map
 *  with the `orig:` prefix, so the parser holds them to this shape rather than
 *  letting a hand-edited `orig:x` shadow a real original. */
const ID_SHAPE = /^[A-Za-z0-9_-]{1,40}$/;

export const DEFAULT_SCENE_PRESETS: ScenePresets = { expand: () => undefined, fallback: "aurora" };

function clampTo(value: unknown, range: { min: number; max: number }, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(range.max, Math.max(range.min, Math.round(value)));
}

export function expandGradientPreset(value: unknown, presets: ScenePresets, mode: "light" | "dark"): CustomGradientSpec {
  const named = typeof value === "string" && ID_SHAPE.test(value) ? presets.expand(value, mode) : undefined;
  return named ?? presets.expand(presets.fallback, mode) ?? DEFAULT_GRADIENT_SPECS[mode];
}

export function parseSceneLayer(value: unknown, presets: ScenePresets = DEFAULT_SCENE_PRESETS, mode: "light" | "dark" = "light"): SceneLayer | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.type === "gradient") {
    // Its own spec if it has one; otherwise the preset a v2 layer named.
    const spec = parseGradientSpec(record.spec) ?? expandGradientPreset(record.presetId, presets, mode);
    return { type: "gradient", spec, opacity: clampTo(record.opacity, SCENE_LIMITS.opacity, SCENE_LIMITS.opacity.max) };
  }
  if (record.type === "custom-gradient") {
    if (!isGradientValue(record.css)) return undefined;
    return {
      type: "gradient",
      spec: parseGradientCss(record.css) ?? DEFAULT_GRADIENT_SPECS[mode],
      opacity: clampTo(record.opacity, SCENE_LIMITS.opacity, SCENE_LIMITS.opacity.max),
    };
  }
  if (typeof record.id !== "string" || !ID_SHAPE.test(record.id)) return undefined;
  return {
    type: "image",
    id: record.id,
    x: clampTo(record.x, SCENE_LIMITS.x, DEFAULT_LAYER.x),
    y: clampTo(record.y, SCENE_LIMITS.y, DEFAULT_LAYER.y),
    scale: clampTo(record.scale, SCENE_LIMITS.scale, DEFAULT_LAYER.scale),
    opacity: clampTo(record.opacity, SCENE_LIMITS.opacity, DEFAULT_LAYER.opacity),
    tiled: record.tiled === true,
  };
}

export function parseSceneLayers(value: unknown, presets: ScenePresets = DEFAULT_SCENE_PRESETS, mode: "light" | "dark" = "light"): SceneLayer[] {
  if (!Array.isArray(value)) return [];
  const layers: SceneLayer[] = [];
  const seen = new Set<string>();
  let images = 0;
  let gradients = 0;
  for (const entry of value) {
    const layer = parseSceneLayer(entry, presets, mode);
    if (!layer) continue;
    if (layer.type === "image") {
      if (seen.has(layer.id) || images >= MAX_SCENE_LAYERS) continue;
      seen.add(layer.id);
      images += 1;
    } else {
      if (gradients >= MAX_SCENE_GRADIENT_LAYERS) continue;
      gradients += 1;
    }
    layers.push(layer);
  }
  return layers;
}

export function parseScene(raw: string | null, presets: ScenePresets = DEFAULT_SCENE_PRESETS, mode: "light" | "dark" = "light"): Scene {
  const empty: Scene = { layers: [{ type: "gradient", spec: expandGradientPreset(presets.fallback, presets, mode), opacity: SCENE_LIMITS.opacity.max }] };
  try {
    const parsed: unknown = JSON.parse(raw ?? "null");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return empty;
    const record = parsed as Record<string, unknown>;
    const stored = record.layers;
    const hasBase = typeof record.baseId === "string";
    if (!Array.isArray(stored) && !hasBase) return empty;
    const layers = parseSceneLayers(stored, presets, mode);
    const gradients = layers.reduce((count, layer) => count + (layer.type === "image" ? 0 : 1), 0);
    if (hasBase && gradients < MAX_SCENE_GRADIENT_LAYERS) {
      layers.push({ type: "gradient", spec: expandGradientPreset(record.baseId, presets, mode), opacity: SCENE_LIMITS.opacity.max });
    }
    return { layers };
  } catch {
    return empty;
  }
}

/** The image map, keeping only entries that are actually image data URLs. */
export function parseSceneImages(raw: string | null): Record<string, string> {
  const images: Record<string, string> = {};
  try {
    const parsed: unknown = JSON.parse(raw ?? "null");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return images;
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string" && value.startsWith("data:image/")) images[key] = value;
    }
  } catch {
    // Corrupt map: no layer images, which composes to just the base.
  }
  return images;
}

/* ═══════════════════════════════════════════════════════════ the Look ═══ */

export type LookBackdrop =
  | { kind: "none" }
  | { kind: "gradient"; id: string; dim?: number; resolved: BackdropLayers }
  | { kind: "custom-gradient"; light: string; dark: string; dim?: number; resolved: BackdropLayers }
  | { kind: "image"; fit: BackdropFit; blur: number; dim: number; image: string }
  | { kind: "scene"; scene: Scene; sceneDark: Scene; images: Record<string, string>; dim?: number; resolved: BackdropLayers };

/* ═══════════════════════════════════════════════════ the composition ═══ */

export type CompositionState = {
  /** The app colour for this state. Any value `isSafeColour` accepts. */
  base: string;
  layers: SceneLayer[];
  /** Tokens set by hand, over what the base derived. */
  overrides: Partial<ThemeHalf>;
};

export type Composition = { light: CompositionState; dark: CompositionState };

/** The base the identity look wears — Telar's own canvas, which derives to
 *  Telar's own palette because that is the spine the engine keeps. */
export const DEFAULT_BASE_LIGHT = "#f8f8f9";
export const DEFAULT_BASE_DARK = "#252525";

export function parseCompositionState(value: unknown, mode: "light" | "dark", presets: ScenePresets = DEFAULT_SCENE_PRESETS): CompositionState {
  const fallbackBase = mode === "light" ? DEFAULT_BASE_LIGHT : DEFAULT_BASE_DARK;
  if (!isRecord(value)) return { base: fallbackBase, layers: [], overrides: {} };
  const overrides: Partial<ThemeHalf> = {};
  if (isRecord(value.overrides)) {
    for (const token of THEME_TOKENS) {
      const candidate = value.overrides[token];
      if (isSafeColour(candidate)) overrides[token] = candidate;
    }
  }
  return {
    base: isSafeColour(value.base) ? value.base : fallbackBase,
    layers: parseSceneLayers(value.layers, presets, mode),
    overrides,
  };
}

export function parseComposition(value: unknown, presets: ScenePresets = DEFAULT_SCENE_PRESETS): Composition {
  const record = isRecord(value) ? value : {};
  return {
    light: parseCompositionState(record.light, "light", presets),
    dark: parseCompositionState(record.dark, "dark", presets),
  };
}

export type Look = {
  version: 2;
  id: string;
  label: string;
  /** What the app looks like, in both states. */
  composition: Composition;
  images: Record<string, string>;
  accent: Accent;
  fontSans: SansFont;
  fontMono: MonoFont;
  fontSansCustom: string;
  fontMonoCustom: string;
  fontSize: number;
  fontMonoSize: number;
  translucencyLevel: number;
  depth: Depth;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(value as string) ? (value as T) : fallback;
}

/** A half, filled from the Telar base for anything missing or unsafe — the
 *  same "concrete or default" contract the editor gets, so a partial file
 *  paints a complete theme rather than a half-styled app. */
export function parseThemeHalf(value: unknown, mode: "light" | "dark"): ThemeHalf {
  const base = mode === "light" ? TELAR_LIGHT : TELAR_DARK;
  if (!isRecord(value)) return { ...base };
  const half: ThemeHalf = { ...base };
  for (const token of THEME_TOKENS) {
    const candidate = value[token];
    if (isSafeColour(candidate)) half[token] = candidate;
  }
  return half;
}

function parseLayers(value: unknown, check: (candidate: unknown) => candidate is string): BackdropLayers | undefined {
  if (!isRecord(value) || !check(value.light)) return undefined;
  const list = (candidate: unknown) =>
    typeof candidate === "string" && candidate.length > 0 && !candidate.includes(";") && !candidate.includes("}") ? candidate : undefined;
  const size = list(value.size);
  const position = list(value.position);
  const repeat = list(value.repeat);
  return {
    light: value.light,
    dark: check(value.dark) ? value.dark : value.light,
    ...(size ? { size } : {}),
    ...(position ? { position } : {}),
    ...(repeat ? { repeat } : {}),
  };
}

export function parseLookBackdrop(value: unknown, presets: ScenePresets = DEFAULT_SCENE_PRESETS): LookBackdrop {
  if (!isRecord(value)) return { kind: "none" };
  // Absent stays absent — a missing dim must not round-trip into `dim: 0`.
  const dim = (raw: unknown): { dim?: number } => {
    const clamped = clampInt(raw, 0, MAX_BACKDROP_DIM, 0);
    return clamped > 0 ? { dim: clamped } : {};
  };
  if (value.kind === "gradient" && typeof value.id === "string" && value.id.length > 0) {
    const resolved = parseLayers(value.resolved, isGradientValue);
    return resolved ? { kind: "gradient", id: value.id, ...dim(value.dim), resolved } : { kind: "none" };
  }
  if (value.kind === "custom-gradient") {
    const resolved = parseLayers(value.resolved, isGradientValue);
    if (!resolved || !isGradientValue(value.light)) return { kind: "none" };
    return { kind: "custom-gradient", light: value.light, dark: isGradientValue(value.dark) ? value.dark : value.light, ...dim(value.dim), resolved };
  }
  if (value.kind === "image") {
    // An image choice resolves through the image payload, not through layers,
    // so the data URL IS the payload — and without it there is nothing to paint.
    if (typeof value.image !== "string" || !value.image.startsWith("data:image/")) return { kind: "none" };
    return {
      kind: "image",
      fit: oneOf<BackdropFit>(value.fit, BACKDROP_FITS, "cover"),
      blur: clampInt(value.blur, 0, MAX_BACKDROP_BLUR, 0),
      dim: clampInt(value.dim, 0, MAX_BACKDROP_DIM, 0),
      image: value.image,
    };
  }
  if (value.kind === "scene") {
    const resolved = parseLayers(value.resolved, isSceneValue);
    if (!resolved) return { kind: "none" };
    // Round-tripped through the composer's own parsers: the same clamping and
    // the same "only real image data URLs" filter the composer applies. Twice,
    // once per state — see the `scene` variant above.
    const raw = JSON.stringify(value.scene ?? null);
    const images = parseSceneImages(JSON.stringify(value.images ?? null));
    return { kind: "scene", scene: parseScene(raw, presets, "light"), sceneDark: parseScene(raw, presets, "dark"), images, ...dim(value.dim), resolved };
  }
  return { kind: "none" };
}

export function compositionFromV1(
  theme: { light: ThemeHalf; dark: ThemeHalf },
  backdrop: LookBackdrop,
  presets: ScenePresets = DEFAULT_SCENE_PRESETS,
): { composition: Composition; images: Record<string, string> } {
  const images: Record<string, string> = {};
  const layers: SceneLayer[] = [];
  // The one kind whose two states genuinely differ: everything else is one
  // stored value, so the dark stack is a copy of the light one.
  let darkOverride: SceneLayer[] | undefined;
  if (backdrop.kind === "gradient") {
    layers.push({ type: "gradient", spec: expandGradientPreset(backdrop.id, presets, "light"), opacity: SCENE_LIMITS.opacity.max });
    darkOverride = [{ type: "gradient", spec: expandGradientPreset(backdrop.id, presets, "dark"), opacity: SCENE_LIMITS.opacity.max }];
  } else if (backdrop.kind === "custom-gradient") {
    const spec = (css: string, mode: "light" | "dark") => parseGradientCss(css) ?? DEFAULT_GRADIENT_SPECS[mode];
    layers.push({ type: "gradient", spec: spec(backdrop.light, "light"), opacity: SCENE_LIMITS.opacity.max });
    darkOverride = [{ type: "gradient", spec: spec(backdrop.dark, "dark"), opacity: SCENE_LIMITS.opacity.max }];
  } else if (backdrop.kind === "image") {
    const id = "migrated";
    images[id] = backdrop.image;
    layers.push({ type: "image", id, x: 50, y: 50, scale: 100, opacity: SCENE_LIMITS.opacity.max, tiled: backdrop.fit === "tile" });
  } else if (backdrop.kind === "scene") {
    layers.push(...backdrop.scene.layers);
    darkOverride = backdrop.sceneDark.layers.map((layer) => ({ ...layer }));
    Object.assign(images, backdrop.images);
  }
  const darkLayers = darkOverride ?? layers.map((layer) => ({ ...layer }));
  const state = (half: ThemeHalf, stack: SceneLayer[]): CompositionState => ({
    base: half.background,
    layers: stack,
    overrides: { ...half },
  });
  return { composition: { light: state(theme.light, layers), dark: state(theme.dark, darkLayers) }, images };
}

/** The image map, keeping only entries that are actually image data URLs. */
function parseImages(value: unknown): Record<string, string> {
  const images: Record<string, string> = {};
  if (!isRecord(value)) return images;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" && entry.startsWith("data:image/")) images[key] = entry;
  }
  return images;
}

/** One Look, or undefined when there is not even an id and a label to show —
 *  the only two members a card cannot be drawn without. */
export function parseLook(value: unknown, presets: ScenePresets = DEFAULT_SCENE_PRESETS): Look | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.id !== "string" || value.id.length === 0) return undefined;
  if (typeof value.label !== "string") return undefined;
  const migrated = !isRecord(value.composition) && isRecord(value.theme);
  const old = isRecord(value.theme) ? value.theme : {};
  const fromV1 = migrated
    ? compositionFromV1(
        { light: parseThemeHalf(old.light, "light"), dark: parseThemeHalf(old.dark, "dark") },
        parseLookBackdrop(value.backdrop, presets),
        presets,
      )
    : undefined;
  return {
    version: 2,
    id: value.id,
    label: value.label,
    composition: fromV1 ? fromV1.composition : parseComposition(value.composition, presets),
    images: fromV1 ? fromV1.images : parseImages(value.images),
    accent: oneOf<Accent>(value.accent, ACCENTS, DEFAULT_ACCENT),
    fontSans: oneOf<SansFont>(value.fontSans, SANS_FONTS, DEFAULT_SANS_FONT),
    fontMono: oneOf<MonoFont>(value.fontMono, MONO_FONTS, DEFAULT_MONO_FONT),
    fontSansCustom: typeof value.fontSansCustom === "string" ? value.fontSansCustom : "",
    fontMonoCustom: typeof value.fontMonoCustom === "string" ? value.fontMonoCustom : "",
    fontSize: clampInt(value.fontSize, MIN_FONT_SIZE, MAX_FONT_SIZE, DEFAULT_FONT_SIZE),
    // Absent in every Look written before this field existed, and a total
    // parser must not reject those — it defaults, like every other member.
    fontMonoSize: clampInt(value.fontMonoSize, MIN_MONO_FONT_SIZE, MAX_MONO_FONT_SIZE, DEFAULT_MONO_FONT_SIZE),
    translucencyLevel: clampInt(value.translucencyLevel, MIN_TRANSLUCENCY, MAX_TRANSLUCENCY, DEFAULT_TRANSLUCENCY_LEVEL),
    // Absent in every Look written before the elevation ladder existed, which
    // is exactly what the default is for — an older file wears "soft" and
    // looks the way it always did.
    depth: oneOf<Depth>(value.depth, DEPTHS, DEFAULT_DEPTH),
  };
}

/* ═══════════════════════════════════════════ the published appearance ═══ */

export type PublishedScheme = "light" | "dark" | "system";
export type PublishedFrost = "blur" | "clear";

/** One accent, as the two tokens globals.css actually sets for it. */
export type PublishedAccentColours = { primary: string; primaryForeground: string };

export type PublishedResolved = {
  accent: { name: Accent; light: PublishedAccentColours; dark: PublishedAccentColours };
  /** Real `font-family` values, not `var(--font-geist-sans)` — the publisher
   *  resolves the cockpit's font variables into stacks a client can set. */
  fontStacks: { sans: string; mono: string };
};

export type PublishedAppearance = {
  version: 2;
  updatedAtHint: number;
  scheme: PublishedScheme;
  translucent: boolean;
  frost: PublishedFrost;
  resolved?: PublishedResolved;
  look: Look;
};

/** A resolved CSS value that is not a colour — a font stack. Same reasoning as
 *  isSafeColour, one size up: these end up in a `font-family` declaration. */
function isSafeCssValue(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[;{}<>]/.test(value);
}

function parseAccentColours(value: unknown): PublishedAccentColours | undefined {
  if (!isRecord(value) || !isSafeColour(value.primary) || !isSafeColour(value.primaryForeground)) return undefined;
  return { primary: value.primary, primaryForeground: value.primaryForeground };
}

function parseResolved(value: unknown): PublishedResolved | undefined {
  if (!isRecord(value)) return undefined;
  const accent = isRecord(value.accent) ? value.accent : undefined;
  const light = parseAccentColours(accent?.light);
  const dark = parseAccentColours(accent?.dark);
  const stacks = isRecord(value.fontStacks) ? value.fontStacks : undefined;
  if (!light || !dark || !isSafeCssValue(stacks?.sans) || !isSafeCssValue(stacks?.mono)) return undefined;
  return {
    accent: { name: oneOf<Accent>(accent?.name, ACCENTS, DEFAULT_ACCENT), light, dark },
    fontStacks: { sans: stacks.sans, mono: stacks.mono },
  };
}

export function parsePublishedAppearance(value: unknown, presets: ScenePresets = DEFAULT_SCENE_PRESETS): PublishedAppearance | undefined {
  if (!isRecord(value)) return undefined;
  const look = parseLook(value.look, presets);
  if (!look) return undefined;
  const resolved = parseResolved(value.resolved);
  return {
    version: 2,
    updatedAtHint: typeof value.updatedAtHint === "number" && Number.isFinite(value.updatedAtHint) ? value.updatedAtHint : 0,
    scheme: oneOf<PublishedScheme>(value.scheme, ["light", "dark", "system"], "system"),
    translucent: value.translucent === true,
    frost: oneOf<PublishedFrost>(value.frost, ["blur", "clear"], "blur"),
    ...(resolved ? { resolved } : {}),
    look,
  };
}
