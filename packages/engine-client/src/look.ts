/**
 * THE LOOK FORMAT — one vocabulary, on the wire and in the browser.
 *
 * WHY THIS LIVES IN THE PROTOCOL PACKAGE AND NOT IN THE WEB APP. A Look started
 * as a browser thing: capture every appearance store, write one JSON file, wear
 * it on another machine. Then the cockpit began PUBLISHING its look to the
 * engine so a paired client could wear it too — and published a second, poorer
 * vocabulary to do it (sixteen tokens per half, an accent NAME, a backdrop
 * KIND). Two formats for one idea is one format too many: the poorer one could
 * not carry a wallpaper, could not carry the composed scene, and drifted every
 * time the richer one grew. So the RICH one moved here, where the engine, the
 * cockpit and any future client can all name the same shape.
 *
 * PURE, AND THAT IS THE CONSTRAINT THAT KEEPS IT SHARED. Nothing in this file
 * touches the DOM, localStorage, React or Tailwind — it is types, plain data
 * tables, and total parsers over `unknown`. The web app's own modules
 * (lib/looks.ts, lib/backdrop.ts, lib/scene-composer.ts) re-export what moved
 * and keep everything that decides anything about a live document.
 *
 * PARSING IS TOTAL, and it has to be twice over: a Look arrives from a FILE the
 * reader picked, and now also from an ENGINE any paired device may have written
 * to. Every member degrades to a default rather than throwing, and every value
 * that will end up inside a compiled stylesheet passes a gate first
 * (`isSafeColour`, `isGradientValue`, `isSceneValue`) — a blob that crossed a
 * trust boundary must not be able to close a declaration and open a rule.
 */

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

/** The base palette's real values, restated once — apps/web/app/globals.css is
 *  where they actually paint from, and the "telar" identity theme compiles to
 *  nothing precisely because these ARE its values. A parser needs them
 *  concrete: a half filled from a partial file must still paint a whole app. */
export const TELAR_LIGHT: ThemeHalf = {
  background: "oklch(0.992 0 0)",
  foreground: "oklch(0.274 0.006 286)",
  card: "oklch(1 0 0)",
  "card-foreground": "oklch(0.274 0.006 286)",
  popover: "oklch(1 0 0)",
  "popover-foreground": "oklch(0.274 0.006 286)",
  secondary: "oklch(0.96 0.002 286)",
  "secondary-foreground": "oklch(0.274 0.006 286)",
  muted: "oklch(0.967 0.001 286)",
  "muted-foreground": "oklch(0.525 0.016 286)",
  accent: "oklch(0.955 0.002 286)",
  "accent-foreground": "oklch(0.21 0.006 286)",
  border: "oklch(0.92 0.004 286)",
  input: "oklch(0.66 0.008 286)",
  sidebar: "oklch(0.972 0.001 286)",
  "sidebar-accent": "oklch(0.945 0.003 286)",
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

/** Accent names double as `data-accent` values in the cockpit; the hues live in
 *  globals.css. A published look also carries the RESOLVED hex/oklch, because a
 *  client that never loaded that stylesheet cannot look a name up. */
export const ACCENTS = ["indigo", "sky", "sea", "moss", "amber", "rose", "plum", "violet"] as const;
export type Accent = (typeof ACCENTS)[number];

/** "custom" has no stylesheet block anywhere: the look's own
 *  `fontSansCustom` / `fontMonoCustom` is what makes it mean something. */
export const SANS_FONTS = ["geist", "inter", "system", "custom"] as const;
export type SansFont = (typeof SANS_FONTS)[number];

export const MONO_FONTS = ["geist", "jetbrains", "system", "custom"] as const;
export type MonoFont = (typeof MONO_FONTS)[number];

/** The root px the whole interface is measured in — every rem-based dimension
 *  scales with it, which is the point: this is a zoom, not a text-only tweak. */
export const MIN_FONT_SIZE = 13;
export const MAX_FONT_SIZE = 18;

/** The translucency slider's DISPLAY scale (the cockpit maps it onto the real
 *  alpha range before any CSS sees it). */
export const MIN_TRANSLUCENCY = 0;
export const MAX_TRANSLUCENCY = 100;

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

/** Resolved CSS values, one `background-image` per colour scheme. A composed
 *  scene ALSO carries the per-layer lists (`background-size/position/repeat`
 *  take one comma entry per image layer); single-source kinds leave those to
 *  the stylesheet's defaults. */
export type BackdropLayers = { light: string; dark: string; size?: string; position?: string; repeat?: string };

/**
 * A colour value is going into a COMPILED STYLESHEET (the cockpit joins the
 * declarations with `;` and wraps them in `{ }`), so a value carrying either
 * character would close the block and let whatever follows become new rules.
 * Values typed into the editor cannot contain them; a Look arrives from a file
 * or from the engine, so its values are held to the shape a declaration value
 * has.
 */
export function isSafeColour(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[;{}<>]/.test(value);
}

/**
 * A custom gradient becomes a CSS variable via CSSOM `setProperty` — which
 * cannot escape the declaration — but a nonsense value silently paints
 * nothing, so writes are gated on looking like an actual gradient list.
 */
export function isGradientValue(value: unknown): value is string {
  return typeof value === "string" && /gradient\(/.test(value) && !value.includes(";") && !value.includes("}") && !/url\s*\(/i.test(value);
}

/** A composed scene's background-image list: any mix of gradients and
 *  `url("data:image/…")` layers — data URLs ONLY, so a stored scene can never
 *  make the page fetch anything — and still no way out of the declaration. */
export function isSceneValue(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes(";") || value.includes("}")) return false;
  return value
    .split(/url\(/i)
    .slice(1)
    .every((segment) => segment.startsWith('"data:image/'));
}

/* ═══════════════════════════════════════════════ the scene vocabulary ═══ */

/** One image in the stack. Positions are `background-position` percentages,
 *  `scale` is the `background-size` WIDTH percentage (height stays `auto`, so
 *  the picture never distorts), and `opacity` is baked into the pixels. */
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

/** One preset gradient in the stack, painted full-bleed. `opacity` is applied
 *  in CSS by rewriting the gradient's own colour alphas, so it costs nothing
 *  to drag. */
export type SceneGradientLayer = {
  type: "gradient";
  presetId: string;
  /** 10-100, written into the gradient's colours. */
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

/**
 * WHICH GRADIENT PRESETS EXIST IS THE APP'S BUSINESS, NOT THE FORMAT'S.
 *
 * `parseScene` has always been forgiving of a preset id this build does not
 * have — a scene naming a dropped preset should change colour, not stop
 * composing — and doing that requires knowing the table. The table is a web
 * module full of tuned gradients; importing it here would drag the cockpit's
 * design into the protocol. So the knowledge is a PARAMETER: the cockpit hands
 * in its real table, and a client reading a published look uses the permissive
 * default below (an id it cannot resolve is kept, and whatever paints the
 * scene decides what to do with it — the resolved layers travel anyway).
 */
export type ScenePresets = { known: (id: string) => boolean; fallback: string };

/** Ids are generated, never typed — but they are also JSON keys sharing a map
 *  with the `orig:` prefix, so the parser holds them to this shape rather than
 *  letting a hand-edited `orig:x` shadow a real original. */
const ID_SHAPE = /^[A-Za-z0-9_-]{1,40}$/;

/** The permissive gate: any plausible id is kept, and the fallback names the
 *  cockpit's own first preset so a scene with no readable base still has one. */
export const DEFAULT_SCENE_PRESETS: ScenePresets = { known: (id) => ID_SHAPE.test(id), fallback: "aurora" };

function clampTo(value: unknown, range: { min: number; max: number }, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(range.max, Math.max(range.min, Math.round(value)));
}

function presetIdOr(value: unknown, presets: ScenePresets): string {
  return typeof value === "string" && presets.known(value) ? value : presets.fallback;
}

/** One layer, or undefined. Every field is clamped into range rather than
 *  refused: a stale scale from an older build should move the slider, not
 *  delete someone's arrangement. Only a missing/malformed id is fatal — and
 *  only for image layers, which is also the DEFAULT reading: scenes written
 *  before gradient layers existed have no `type` member at all. */
export function parseSceneLayer(value: unknown, presets: ScenePresets = DEFAULT_SCENE_PRESETS): SceneLayer | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.type === "gradient") {
    return { type: "gradient", presetId: presetIdOr(record.presetId, presets), opacity: clampTo(record.opacity, SCENE_LIMITS.opacity, SCENE_LIMITS.opacity.max) };
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

/**
 * Total: anything unrecognised is the default scene, so a truncated or
 * hand-edited value can never wedge the composer.
 *
 * MIGRATION. A stored `baseId` is the old mandatory base; it becomes the
 * BOTTOM gradient layer at full opacity, which is the same picture. Its
 * absence is meaningful in the new model — an explicit "nothing underneath" —
 * so it is only supplied when the value has neither a `layers` array nor a
 * `baseId` at all, i.e. when there is no scene here to read.
 */
export function parseScene(raw: string | null, presets: ScenePresets = DEFAULT_SCENE_PRESETS): Scene {
  const empty: Scene = { layers: [{ type: "gradient", presetId: presets.fallback, opacity: SCENE_LIMITS.opacity.max }] };
  try {
    const parsed: unknown = JSON.parse(raw ?? "null");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return empty;
    const record = parsed as Record<string, unknown>;
    const stored = record.layers;
    const hasBase = typeof record.baseId === "string";
    if (!Array.isArray(stored) && !hasBase) return empty;
    const layers: SceneLayer[] = [];
    const seen = new Set<string>();
    let images = 0;
    let gradients = 0;
    if (Array.isArray(stored)) {
      for (const entry of stored) {
        const layer = parseSceneLayer(entry, presets);
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
    }
    if (hasBase && gradients < MAX_SCENE_GRADIENT_LAYERS) {
      layers.push({ type: "gradient", presetId: presetIdOr(record.baseId, presets), opacity: SCENE_LIMITS.opacity.max });
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

/**
 * The backdrop as a Look carries it: the CHOICE, its RESOLVED CSS, and — for
 * the kinds whose pixels live outside the choice — the payloads themselves. A
 * composed scene keeps its editable source too, so wearing a Look leaves the
 * scene composer populated rather than showing an arrangement it cannot edit.
 */
export type LookBackdrop =
  | { kind: "none" }
  | { kind: "gradient"; id: string; dim?: number; resolved: BackdropLayers }
  | { kind: "custom-gradient"; light: string; dark: string; dim?: number; resolved: BackdropLayers }
  | { kind: "image"; fit: BackdropFit; blur: number; dim: number; image: string }
  | { kind: "scene"; scene: Scene; images: Record<string, string>; dim?: number; resolved: BackdropLayers };

export type Look = {
  /** Bumped only for a change no total parser could absorb; the parser accepts
   *  a missing version as 1, so files from this build's own lifetime keep
   *  opening after a bump that only adds members. */
  version: 1;
  id: string;
  label: string;
  /** Both halves CONCRETE, never a theme id: an id the reader cannot look up
   *  is a dangling pointer the moment the file leaves the machine that made
   *  it, and a mixed pair (one theme's day, another's night) is itself a look. */
  theme: { light: ThemeHalf; dark: ThemeHalf };
  backdrop: LookBackdrop;
  accent: Accent;
  fontSans: SansFont;
  fontMono: MonoFont;
  fontSansCustom: string;
  fontMonoCustom: string;
  fontSize: number;
  translucencyLevel: number;
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

/** The resolved layers, held to the store's OWN gate: `check` is
 *  isGradientValue for the gradient kinds and isSceneValue for a scene, so a
 *  Look can never write something the backdrop would silently drop. */
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

/**
 * The backdrop half of a Look. Anything that does not survive its kind's gate
 * becomes "none" — a Look that paints nothing is a legible outcome; a Look
 * that sets `data-backdrop` with no layers behind it is a frosted wash hanging
 * over a bare canvas.
 */
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
    // the same "only real image data URLs" filter the composer applies.
    const scene = parseScene(JSON.stringify(value.scene ?? null), presets);
    const images = parseSceneImages(JSON.stringify(value.images ?? null));
    return { kind: "scene", scene, images, ...dim(value.dim), resolved };
  }
  return { kind: "none" };
}

/** One Look, or undefined when there is not even an id and a label to show —
 *  the only two members a card cannot be drawn without. */
export function parseLook(value: unknown, presets: ScenePresets = DEFAULT_SCENE_PRESETS): Look | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.id !== "string" || value.id.length === 0) return undefined;
  if (typeof value.label !== "string") return undefined;
  // Version is advisory: a FUTURE version is still read on a best effort,
  // because every member below already falls back on its own.
  const theme = isRecord(value.theme) ? value.theme : {};
  return {
    version: 1,
    id: value.id,
    label: value.label,
    theme: { light: parseThemeHalf(theme.light, "light"), dark: parseThemeHalf(theme.dark, "dark") },
    backdrop: parseLookBackdrop(value.backdrop, presets),
    accent: oneOf<Accent>(value.accent, ACCENTS, DEFAULT_ACCENT),
    fontSans: oneOf<SansFont>(value.fontSans, SANS_FONTS, DEFAULT_SANS_FONT),
    fontMono: oneOf<MonoFont>(value.fontMono, MONO_FONTS, DEFAULT_MONO_FONT),
    fontSansCustom: typeof value.fontSansCustom === "string" ? value.fontSansCustom : "",
    fontMonoCustom: typeof value.fontMonoCustom === "string" ? value.fontMonoCustom : "",
    fontSize: clampInt(value.fontSize, MIN_FONT_SIZE, MAX_FONT_SIZE, DEFAULT_FONT_SIZE),
    translucencyLevel: clampInt(value.translucencyLevel, MIN_TRANSLUCENCY, MAX_TRANSLUCENCY, DEFAULT_TRANSLUCENCY_LEVEL),
  };
}

/* ═══════════════════════════════════════════ the published appearance ═══ */

/**
 * WHAT THE HOST COCKPIT PUBLISHES — the whole Look, plus the few things a Look
 * deliberately is NOT.
 *
 * A Look is TASTE and travels between machines untouched. Three facts about
 * THIS WINDOW ride beside it rather than inside it, because a reader needs
 * them and a shared file must not carry them:
 *
 *   `scheme`       which half is being worn right now (light/dark/system).
 *                  Not in a Look: a Look has both halves, and which one you
 *                  are looking at is a property of the window.
 *   `translucent`  and `frost` — properties of the MACHINE. Turning
 *                  translucency on rebuilds a desktop window; frost is macOS
 *                  vibrancy. A phone cannot wear either, but it can want to
 *                  KNOW, so they are reported and never applied blind.
 *   `resolved`     the accent and typefaces as real CSS, because `"amber"` and
 *                  `"geist"` are names only this app's stylesheet can look up.
 *
 * ADDITIVE FOR READERS, VERSIONED FOR MEANING. `version: 2` marks the break
 * from the first, poorer blob (theme halves and scalar names only); new keys
 * after this need no bump, because `parsePublishedAppearance` falls back per
 * member and readers ignore what they do not recognise.
 */
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
  /** What the PUBLISHER believed the time was. Advisory only: the engine stamps
   *  its own `updatedAt` on arrival, and that is the one an ETag is cut from. */
  updatedAtHint: number;
  scheme: PublishedScheme;
  translucent: boolean;
  frost: PublishedFrost;
  /** Absent when nothing readable was published — a reader that only wants the
   *  Look never needs it, and half-resolved colours are worse than none. */
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

/** ALL OR NOTHING. A half-resolved accent would let a client paint a button
 *  with a foreground that never matched its background; a missing `resolved`
 *  is a state every reader already has to handle. */
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

/**
 * Total, and gated: this blob crossed a trust boundary (any paired device can
 * PUT it), so every colour that could reach a stylesheet passes `isSafeColour`
 * on the way in. Undefined means "there is no look here" — the only fatal
 * member is the Look itself, because everything else has a defensible default.
 */
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
