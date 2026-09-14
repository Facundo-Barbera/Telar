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

/** Accent names double as `data-accent` values in the cockpit; the hues live in
 *  globals.css. A published look also carries the RESOLVED hex/oklch, because a
 *  client that never loaded that stylesheet cannot look a name up. */
export const ACCENTS = ["indigo", "sky", "sea", "moss", "amber", "rose", "plum", "violet"] as const;
export type Accent = (typeof ACCENTS)[number];

/** "custom" has no stylesheet block anywhere: the look's own
 *  `fontSansCustom` / `fontMonoCustom` is what makes it mean something. */
/**
 * ONE CATALOGUE, OFFERED TO BOTH SLOTS.
 *
 * The lists used to be disjoint, which quietly encoded an opinion nobody
 * asked for: that a monospaced face is for code and never for the interface.
 * Plenty of people want the whole app in JetBrains Mono. So both slots now
 * choose from the same set, and the LABEL is what differs by role — `geist`
 * is Geist in the interface slot and Geist Mono in the code slot, which is
 * what it has always meant in each and is why the id stays shared rather than
 * splitting into two that would strand every stored preference.
 *
 * The two type names survive because every caller distinguishes the two
 * SLOTS even now that they share a range.
 */
/**
 * THE DEFAULT IS ELEMENT ZERO AND HAS TO STAY THERE — the cockpit's pre-paint
 * script decides "is this the default?" by comparing against the head of the
 * list it is handed (see DEPTHS below for the same contract). Everything after
 * it is ordered proportional faces first, then monospaced, then the two that
 * name no webfont at all; `MONOSPACED_FONTS` is the seam, and the picker draws
 * its headings from it.
 *
 * EVERY ONE OF THESE IS SELF-HOSTED AT BUILD TIME by next/font (apps/web's
 * layout.tsx), so adding a face costs bytes on disk and nothing at runtime —
 * no request leaves the machine to render one.
 */
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

/**
 * Which faces are monospaced. Either slot may take either kind — a reader who
 * wants the whole interface in JetBrains Mono is not making a mistake — so this
 * decides nothing; it is what the picker puts its two headings around, which at
 * fifteen faces is the difference between a list and a wall.
 *
 * `geist` is in neither set on purpose: it is the one id whose face depends on
 * the SLOT (Geist in the interface, Geist Mono in code), which is what it has
 * always meant in each. `geist-mono` is the explicit one, for the interface.
 */
export const MONOSPACED_FONTS: ReadonlySet<string> = new Set([
  "jetbrains",
  "plex-mono",
  "fira-code",
  "geist-mono",
  "source-code-pro",
  "roboto-mono",
  "cascadia-code",
]);

/** The root px the whole interface is measured in — every rem-based dimension
 *  scales with it, which is the point: this is a zoom, not a text-only tweak. */
export const MIN_FONT_SIZE = 13;
export const MAX_FONT_SIZE = 18;

/** The size of MONO CONTENT — code blocks, diffs, file previews, the terminal.
 *  It travels separately because the two answers genuinely differ: a reader
 *  who wants roomy prose usually wants code a notch tighter, and every mono
 *  face runs small at the same nominal size as its sans companion. Chrome that
 *  merely happens to be mono (a panel header) keeps its own size — this is the
 *  size of text you READ, not of labels. */
export const MIN_MONO_FONT_SIZE = 11;
export const MAX_MONO_FONT_SIZE = 18;
export const DEFAULT_MONO_FONT_SIZE = 13;

/** The translucency slider's DISPLAY scale (the cockpit maps it onto the real
 *  alpha range before any CSS sees it). */
export const MIN_TRANSLUCENCY = 0;
export const MAX_TRANSLUCENCY = 100;

/**
 * HOW FAR THE ELEVATION LADDER TRAVELS — `data-depth` on the cockpit's <html>,
 * and the multipliers behind it live in globals.css beside the rungs.
 *
 * IT IS TASTE, SO IT TRAVELS IN A LOOK. `translucent` and `frost` are facts
 * about a MACHINE (macOS vibrancy, a window that has to be rebuilt); depth is
 * a fact about how you want surfaces to read, it means the same thing in a
 * browser tab and a desktop window, and a look built around flat hairlines is
 * a different look from the same palette under deep shadow. So it sits with
 * the accent and the type rather than with the window group.
 *
 * "soft" is the default and, like `indigo` and `geist`, writes no attribute at
 * all — the tokens as authored are soft, and the stylesheet stays the single
 * source of the default look.
 *
 * THE DEFAULT IS FIRST IN THIS LIST AND HAS TO STAY THERE. The cockpit's
 * pre-paint script (APPEARANCE_INIT_SCRIPT) is dependency-free and decides
 * "is this the default?" by comparing against element zero of the list it is
 * handed — the same contract ACCENTS and APP_FONTS already live under.
 * Reordering these would make the default write an attribute and one of the
 * other two stop writing one.
 */
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

/* ════════════════════════════════════════════ the gradient vocabulary ═══ */

/**
 * A GRADIENT SOMEBODY BUILT — the stops, not a preset's name (#471).
 *
 * "It needs gradient customization. We give a lot of options; what if instead
 * we let the user create them." A gradient layer used to be a PRESET ID
 * pointing into a table of eleven authored meshes: the whole vocabulary of
 * what a gradient could be was eleven nouns, and the eleventh-and-a-half was
 * unreachable. So a gradient is now the thing itself — a shape, a direction,
 * and the stops — and the presets survive as STARTING POINTS that fill this
 * spec rather than as a kind you are locked into.
 *
 * THE SPEC, NOT THE RESOLVED CSS. The pre-composer branch had both: a preset
 * layer carrying an id and a `custom-gradient` layer carrying finished CSS,
 * because the CSS "has to paint on a build that never had this app's editor".
 * That reasoning made a gradient unre-editable the moment anything touched the
 * string. It is one layer type now, and it carries the spec — `composeGradient`
 * is total and lives in this package, so any client that can read a Look can
 * also paint one. What a hand-edited CSS value loses is stated at
 * `parseGradientCss`.
 *
 * STOPS CARRY THEIR OWN POSITION AND ALPHA. Evenly-spaced colour-only stops
 * were what made the old round-trip a regex; they were also why every custom
 * gradient looked like the same three bands. A stop is now a colour, where it
 * sits, and how opaque it is — and the alpha rides in the colour as an 8-digit
 * hex, which is the one alpha notation with no comma in it and so the only one
 * that survives a comma-split stop list.
 */
export type GradientType = "linear" | "radial";

/** One stop. `color` is hex — `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa` —
 *  because `<input type="color">` is what authors one and hex is what it
 *  speaks. A bare keyword from a hand-edited value is kept and painted; it
 *  simply cannot be shown in the swatch. */
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
  /** A stop may go all the way to invisible — unlike a LAYER's fade, whose
   *  floor is 10 because a layer you cannot see reads as a broken button. */
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

/** Six lowercase hex digits, or null for anything that is not a hex colour.
 *  Any alpha the value carried is DROPPED — a stop's alpha lives in its own
 *  `opacity`, and two places holding it would eventually disagree. */
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

/**
 * THE ONE PLACE A SPEC BECOMES CSS, and the shape `parseGradientCss` is the
 * exact inverse of: one gradient function, explicit stop percentages, nothing
 * else. Regular enough that the round-trip is a test rather than a hope.
 *
 * Always emits a value `isGradientValue` accepts — no `;`, no `}`, no `url(`
 * can come out of hex colours and integers.
 */
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
/** Hex or a bare keyword only. Comma-bearing functional colours (`rgb()`,
 *  `oklch()`) are deliberately NOT recognised: splitting the stop list on
 *  commas would shred them, and pretending otherwise would parse them wrong
 *  rather than refuse them. */
const STOP_CSS = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]+) (\d{1,3})%$/;

/**
 * The inverse of composeGradient, and ONLY of composeGradient — which is also
 * what the pre-composer branch's `custom-gradient` layers were written by, so
 * every value this app has ever stored reads back exactly.
 *
 * A preset's authored mesh, or anything hand-edited, returns null: the caller
 * then opens on a default rather than on a half-understood parse, which is the
 * honest failure. Never throws.
 */
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
    // The alpha comes back OUT of the colour and into the stop, which is where
    // the editor's own control reads it from.
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

/**
 * ONE AUTHORED GRADIENT IN THE STACK, painted full-bleed.
 *
 * ONE GRADIENT KIND, NOT TWO (#471). There used to be a `gradient` layer
 * holding a preset id and a `custom-gradient` layer holding resolved CSS —
 * which meant "pick one of ours" and "build your own" were different SHAPES,
 * and a preset you liked-but-for-one-colour could not be edited into the thing
 * you wanted without starting over. Both read forward into this one:
 * `parseSceneLayer` expands a preset id into the spec it named, and reads a
 * `custom-gradient`'s CSS back into the stops that made it.
 *
 * `opacity` is the LAYER's own fade, distinct from any stop's: it is applied in
 * CSS by rewriting the composed gradient's colour alphas, so it costs nothing
 * to drag, and it multiplies with whatever the stops already say.
 */
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

/**
 * WHICH GRADIENT STARTERS EXIST IS THE APP'S BUSINESS, NOT THE FORMAT'S.
 *
 * A layer stored by an older build names a PRESET, and reading it forward means
 * knowing what that preset was made of. The table is a web module full of tuned
 * gradients; importing it here would drag the cockpit's design into the
 * protocol. So the knowledge is a PARAMETER: the cockpit hands in its real
 * table, and a client reading a published look uses the permissive default
 * below, which knows no starters at all and falls back to a plain two-stop
 * gradient — a look that arrives from another build changes colour rather than
 * failing to compose.
 */
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

/** A stored preset id as the spec it named. Always answers with a gradient:
 *  an id this build dropped falls to the fallback starter, and a build with no
 *  starter table at all falls to the plain default — a layer that composed to
 *  nothing would be a GAP in a positional list (see composeState). */
export function expandGradientPreset(value: unknown, presets: ScenePresets, mode: "light" | "dark"): CustomGradientSpec {
  const named = typeof value === "string" && ID_SHAPE.test(value) ? presets.expand(value, mode) : undefined;
  return named ?? presets.expand(presets.fallback, mode) ?? DEFAULT_GRADIENT_SPECS[mode];
}

/**
 * One layer, or undefined. Every field is clamped into range rather than
 * refused: a stale scale from an older build should move the slider, not
 * delete someone's arrangement. Only a missing/malformed id is fatal — and
 * only for image layers, which is also the DEFAULT reading: scenes written
 * before gradient layers existed have no `type` member at all.
 *
 * `mode` is WHICH STATE this stack belongs to, and it exists for one reason:
 * the preset a v2 layer names has a light half and a dark half, and expanding
 * the wrong one would retint somebody's night on load. Every caller that knows
 * the state passes it; the legacy scene parser is read twice, once per state.
 */
export function parseSceneLayer(value: unknown, presets: ScenePresets = DEFAULT_SCENE_PRESETS, mode: "light" | "dark" = "light"): SceneLayer | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.type === "gradient") {
    // Its own spec if it has one; otherwise the preset a v2 layer named.
    const spec = parseGradientSpec(record.spec) ?? expandGradientPreset(record.presetId, presets, mode);
    return { type: "gradient", spec, opacity: clampTo(record.opacity, SCENE_LIMITS.opacity, SCENE_LIMITS.opacity.max) };
  }
  if (record.type === "custom-gradient") {
    // The pre-composer layer: resolved CSS, read back into the stops that made
    // it. Not a gradient at all is fatal rather than defaulted — there is no
    // "the gradient they meant" to fall back to, and a layer that paints
    // nothing is a gap in a positional list (see composeState). A gradient this
    // parser cannot take apart (hand-edited, or an authored mesh) keeps its
    // place and opens on the default: the layer survives, its stops do not.
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
/**
 * A STACK, from an already-parsed value — the half of `parseScene` a
 * composition state needs too (its layers arrive inside a Look, not as their
 * own JSON string). Both caps are applied here, so no caller can build a stack
 * the composer would refuse to draw.
 */
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
  /** `scene` and `sceneDark` are the SAME stored stack read once per colour
   *  state — the old model had one scene for both, but a gradient layer in it
   *  named a preset with two halves, so expanding it needs to happen twice or
   *  the migration would paint somebody's night in daylight colours. */
  | { kind: "scene"; scene: Scene; sceneDark: Scene; images: Record<string, string>; dim?: number; resolved: BackdropLayers };

/* ═══════════════════════════════════════════════════ the composition ═══ */

/**
 * ONE STATE OF A COMPOSITION — what the app looks like in one colour scheme.
 *
 * THE COMPOSITION IS THE THEME (#471). There is no separate palette object any
 * more. A state is a BASE colour and a stack of LAYERS over it, and the sixteen
 * surface tokens are DERIVED from the base rather than stored — which is the
 * whole point: "gradient and theme are different things here. We inject the
 * gradients over the theme, where I always thought that a gradient would be
 * part of a theme."
 *
 * THE BASE IS A HUE, NOT A CANVAS COLOUR. It goes through the same engine that
 * turns a photograph into a theme half (the cockpit's palette-from-image), so
 * what it supplies is the hue and how colourful to be; Telar's lightness spine
 * is kept underneath. That is what makes any base yield a READABLE palette
 * rather than letting somebody pick a canvas their text cannot sit on.
 *
 * OVERRIDES ARE THE ESCAPE HATCH, and they are sparse on purpose: a token in
 * here is one somebody set by hand, and everything absent follows the base. A
 * composition migrated from the old theme-pair model therefore arrives with a
 * full set — it has to look exactly as it did — and clearing one hands that
 * token back to the base.
 */
export type CompositionState = {
  /** The app colour for this state. Any value `isSafeColour` accepts. */
  base: string;
  /** The scene over it, TOP LAYER FIRST. Empty means nothing over the base,
   *  which is what "None" is now. */
  layers: SceneLayer[];
  /** Tokens set by hand, over what the base derived. */
  overrides: Partial<ThemeHalf>;
};

/**
 * LIGHT AND DARK ARE TWO STATES OF ONE COMPOSITION, not two themes. The
 * window's colour scheme picks which one is showing; each carries its own base
 * and its own stack, so a scene tuned for daylight is not forced to be the one
 * that shows at night.
 */
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
  /**
   * 2 since the composition replaced the theme pair (#471). A missing version
   * reads as 1 and is MIGRATED rather than refused — see `compositionFromV1`.
   * The number marks a change of meaning; members added later need no bump,
   * because every one of them falls back on its own.
   */
  version: 2;
  id: string;
  label: string;
  /** What the app looks like, in both states. */
  composition: Composition;
  /** Layer images by id, SHARED BY BOTH STATES — a layer id is unique across
   *  the composition, and a dark state that started as a copy of light would
   *  otherwise carry a second megabyte of the same picture. */
  images: Record<string, string>;
  accent: Accent;
  fontSans: SansFont;
  fontMono: MonoFont;
  fontSansCustom: string;
  fontMonoCustom: string;
  fontSize: number;
  fontMonoSize: number;
  translucencyLevel: number;
  /** How far the elevation ladder travels — see DEPTHS. */
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
    // the same "only real image data URLs" filter the composer applies. Twice,
    // once per state — see the `scene` variant above.
    const raw = JSON.stringify(value.scene ?? null);
    const images = parseSceneImages(JSON.stringify(value.images ?? null));
    return { kind: "scene", scene: parseScene(raw, presets, "light"), sceneDark: parseScene(raw, presets, "dark"), images, ...dim(value.dim), resolved };
  }
  return { kind: "none" };
}

/**
 * A LOOK FROM BEFORE THE COMPOSITION EXISTED, read forward.
 *
 * Every Look ever written or exported is a theme PAIR plus a backdrop, and none
 * of them may change appearance on load — a migration that retints somebody's
 * saved work is worse than one that refuses. So:
 *
 *   THE BASE IS THE OLD CANVAS, flat. It is the honest answer to "what colour
 *   was this?" and it is what the base control opens on.
 *   THE OVERRIDES ARE THE WHOLE OLD HALF, which is what makes the migration
 *   lossless: every token is pinned to the value it had, and the base only
 *   starts deciding anything once somebody clears one.
 *   THE BACKDROP BECOMES LAYERS, the same stack in both states — the old model
 *   had one backdrop for both, so splitting it per state would be inventing a
 *   difference nobody asked for.
 *
 * WHAT AN IMAGE BACKDROP LOSES is its `fit`, `blur` and `dim`: a scene layer is
 * positioned and scaled rather than fitted, and has no blur of its own. `cover`
 * and `fill` become a full-bleed layer, `tile` becomes a tiled one, and the
 * picture survives — which is the part somebody would miss.
 *
 * WHAT A GRADIENT BACKDROP BECOMES is the STARTER SPEC its preset named, per
 * state (#471) — the old value was two authored meshes behind one id, and a
 * spec is one gradient, so the picture simplifies where the id did the work.
 * `presets` is where this build's starter table comes in; without one, every
 * gradient falls to the plain default.
 */
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
  // WHICH SHAPE IS THIS? A composition member is the mark of the new one; a
  // `theme` pair with no composition is a file from before it existed, and is
  // migrated rather than half-read. Neither is an error — a Look with neither
  // simply falls to the identity composition, like every other member here.
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
