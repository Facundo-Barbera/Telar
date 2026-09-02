/**
 * THE THEME DESIGNER — a vibe in, a whole theme out.
 *
 * The reader types "warm autumn library" and the engine's configured harness
 * drafts BOTH halves of a theme, a matching backdrop, and an accent. This file
 * is the two ends of that round trip and nothing else: the schema the model is
 * held to, the brief that tells it what the sixteen tokens mean, and the total
 * validator that turns whatever comes back into something the theme library can
 * actually wear. The component does the I/O.
 *
 * WHY THE SCHEMA IS STRICT EVERYWHERE. /api/textgen/complete hands the schema
 * to whichever harness the Text generation setting names, and codex routes it
 * into OpenAI structured outputs — which REJECTS an object schema that omits
 * `additionalProperties: false`, and requires every declared property to appear
 * in `required`. Claude tolerates that shape happily, so strict-everywhere is
 * the only portable schema. The cost is that OPTIONALITY CANNOT BE EXPRESSED BY
 * OMISSION: "no backdrop" is a required `present: false` boolean (with the stop
 * arrays still present, and ignored), never a missing member.
 *
 * WHY VALIDATION IS TOTAL AND REPAIR IS UNCONDITIONAL. A structured-output
 * schema constrains SHAPE, never taste: a model can return a perfectly typed
 * theme whose muted text sits at 1.8:1 on its own canvas. So every foreground
 * is re-measured against the surface it actually lands on and replaced when it
 * fails, using the same helpers (and the same 4.5:1 bar) the VS Code importer
 * repairs with — one contrast policy for both ways a theme can arrive from
 * outside. And applyDesign NEVER throws: its input is a foreign JSON blob, and
 * a thrown error inside a click handler is a blank pane.
 */

import { ACCENTS, type Accent } from "./appearance";
import { MAX_GRADIENT_STOPS, MIN_GRADIENT_STOPS, type CustomGradientSpec } from "./backdrop-presets";
import { hexToCssColor, TELAR_DARK, TELAR_LIGHT, THEME_TOKENS, type ThemeDefinition, type ThemeHalf, type ThemeToken } from "./theme-palettes";
import { contrastRatio, parseVsCodeColor, relativeLuminance, toHex } from "./vscode-theme-import";

/** WCAG AA for body copy — the same bar the VS Code importer holds. */
const READABLE = 4.5;
/** The luminance at which #000 and #fff contrast equally. */
const MID_LUMINANCE = 0.179;

const MAX_LABEL = 48;

/**
 * Which surface each foreground is judged against. `muted-foreground` is
 * secondary text on the CANVAS (hints, timestamps) rather than on `muted`,
 * which is why it is not the pairing the token names suggest.
 */
const FOREGROUND_SURFACES: ReadonlyArray<readonly [ThemeToken, ThemeToken]> = [
  ["foreground", "background"],
  ["card-foreground", "card"],
  ["popover-foreground", "popover"],
  ["secondary-foreground", "secondary"],
  ["muted-foreground", "background"],
  ["accent-foreground", "accent"],
];

// ── The schema ───────────────────────────────────────────────────────────────

const hexProperty = { type: "string", description: "sRGB hex, #RRGGBB" } as const;

function halfSchema(description: string): Record<string, unknown> {
  return {
    type: "object",
    description,
    additionalProperties: false,
    required: [...THEME_TOKENS],
    properties: Object.fromEntries(THEME_TOKENS.map((token) => [token, { ...hexProperty }])),
  };
}

/**
 * What the model must answer with, exactly. Every object carries
 * `additionalProperties: false` and a `required` naming all of its properties
 * — see the header: that is what makes this schema survive the codex harness.
 */
export const DESIGN_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["label", "light", "dark", "backdrop", "accent"],
  properties: {
    label: { type: "string", description: "Two or three words naming the theme, title case." },
    light: halfSchema("The light half: every one of the sixteen surface tokens."),
    dark: halfSchema("The dark half: every one of the sixteen surface tokens."),
    backdrop: {
      type: "object",
      description: "A scenic gradient under the whole app. Set present=false to leave the backdrop alone; the stop arrays are then ignored but must still be sent.",
      additionalProperties: false,
      required: ["present", "angle", "lightStops", "darkStops"],
      properties: {
        present: { type: "boolean", description: "Whether to apply this gradient at all." },
        angle: { type: "number", description: "Linear gradient angle in degrees, 0-359." },
        lightStops: { type: "array", description: "2-4 hex colours for the light scheme, in paint order.", items: { ...hexProperty } },
        darkStops: { type: "array", description: "2-4 hex colours for the dark scheme, in paint order.", items: { ...hexProperty } },
      },
    },
    // An ENUM rather than free hex: the accent is a named family with its own
    // CSS block in globals.css, so "the closest one" is the only answerable
    // question. "none" is the required way to decline.
    accent: { type: "string", description: 'The named accent that suits this theme, or "none" to keep the reader\'s.', enum: [...ACCENTS, "none"] },
  },
};

// ── The brief ────────────────────────────────────────────────────────────────

/** What each token is FOR, in the model's terms — a palette is unbuildable
 *  from token names alone ("accent" here is a hover wash, not the action
 *  colour, and getting that backwards makes every row glow). */
const TOKEN_BRIEF = [
  "background — the app canvas, the largest area on screen",
  "foreground — body text on the canvas",
  "card — panels and cards sitting on the canvas (light half: slightly lighter than canvas; dark half: slightly lighter than canvas)",
  "card-foreground — text on cards",
  "popover — menus and dialogs, floating above cards",
  "popover-foreground — text in menus",
  "secondary — chips, badges, small filled controls",
  "secondary-foreground — text on chips",
  "muted — quiet filled areas (code blocks, empty states)",
  "muted-foreground — secondary text on the canvas: hints, timestamps, captions",
  "accent — the HOVER wash behind a row under the cursor (not the action colour)",
  "accent-foreground — text on a hovered row",
  "border — hairlines between rows and around cards",
  "input — the border of text fields; a touch stronger than border",
  "sidebar — the left rail, distinct from the canvas but of the same family",
  "sidebar-accent — a hovered or selected item in the rail",
].join("\n");

/**
 * The brief. Compact on purpose: this prompt is paid for on every design run
 * through a cold CLI start, and the model's failure mode is never "did not
 * know what a chip is" — it is chroma on the canvas and unreadable secondary
 * text, which is what the two disciplines below are aimed at.
 */
export function buildDesignPrompt(description: string): string {
  return [
    "You are designing a colour theme for Telar, a desktop coding cockpit. Answer ONLY with the JSON the schema describes — no prose, no code fences.",
    "",
    `THE BRIEF: ${description.trim()}`,
    "",
    "A theme is two complete halves, light and dark, each sixteen sRGB hex colours (#RRGGBB):",
    TOKEN_BRIEF,
    "",
    "LIGHTNESS DISCIPLINE (this is what makes a theme usable rather than a poster):",
    "- Light half: canvas is near-white, around 97-99% lightness. Cards sit at or just above the canvas, chips and muted areas a few points below it, borders around 90%.",
    "- Dark half: canvas is near-black, around 13-17% lightness. Cards ~20%, popovers ~23%, chips and muted ~27%, hover ~31%, the rail just below the canvas.",
    "- Every *-foreground must clear 4.5:1 contrast against the surface it names. Body text lands near 27% lightness on light, near 96% on dark; muted text must still clear the bar on the canvas.",
    "",
    "COLOUR DISCIPLINE: hue and personality are welcome and expected — the brief is a mood, not a greyscale. But chroma on the BIG surfaces (canvas, cards, rail) stays at tint level: a visible cast, never a saturated wash. Small surfaces (chips, hover, borders) may carry a little more. Keep one hue family across both halves so they read as one theme.",
    "",
    'BACKDROP: a scenic gradient painted under the whole app and seen through a frosted canvas. Give 2-4 stops per half, evenly spaced along one angle — light stops pale and airy, dark stops deep and moody, both in the brief\'s palette. Set present=false only when the brief plainly wants no scene ("plain", "flat", "no background").',
    "",
    'ACCENT: the named family closest to this theme for buttons and links, or "none" if none of them fit.',
  ].join("\n");
}

// ── Validation and repair ────────────────────────────────────────────────────

/** The failure arm declares the success members as `undefined` rather than
 *  omitting them: a caller that checked `error` first should still be able to
 *  reach for `backdropSpec` without narrowing twice. */
export type DesignFailure = { error: string; definition?: undefined; backdropSpec?: undefined; accent?: undefined };
export type DesignSuccess = {
  error?: undefined;
  definition: Omit<ThemeDefinition, "id">;
  /** Absent when the model declined a backdrop or its stops were unusable. */
  backdropSpec?: { light: CustomGradientSpec; dark: CustomGradientSpec };
  /** Absent when the model said "none" or named something that is not ours. */
  accent?: Accent;
};
export type DesignOutcome = DesignFailure | DesignSuccess;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Any hex the model might send — #RGB and #RRGGBBAA included — normalised to
 *  #RRGGBB. Alpha is dropped rather than honoured: these tokens are opaque
 *  surfaces, and a translucent canvas is not a thing this palette can mean. */
function normalizeHex(value: unknown): string | null {
  const parsed = parseVsCodeColor(value);
  return parsed ? toHex(parsed) : null;
}

function rgbOf(hex: string) {
  return parseVsCodeColor(hex) ?? { r: 0, g: 0, b: 0, a: 1 };
}

/**
 * The importer's repair, applied to a drafted half: a foreground that fails on
 * its own surface is replaced by Telar's own value for that token, and if THAT
 * fails too (the model moved the surface far from where the base was solved)
 * by the greyscale end-stop. The theme keeps its personality everywhere the
 * personality is legible.
 */
function repairHalf(half: ThemeHalf, mode: "light" | "dark"): ThemeHalf {
  const floor = mode === "light" ? TELAR_LIGHT : TELAR_DARK;
  const repaired: ThemeHalf = { ...half };
  for (const [token, surfaceToken] of FOREGROUND_SURFACES) {
    const surface = rgbOf(repaired[surfaceToken]);
    if (contrastRatio(rgbOf(repaired[token]), surface) >= READABLE) continue;
    const fallback = normalizeHex(floor[token]) ?? "#808080";
    repaired[token] =
      contrastRatio(rgbOf(fallback), surface) >= READABLE ? fallback : relativeLuminance(surface) < MID_LUMINANCE ? "#ffffff" : "#000000";
  }
  return repaired;
}

/** One half of the answer, or null when a token is missing or unreadable. */
function readHalf(value: unknown, mode: "light" | "dark"): ThemeHalf | null {
  if (!isRecord(value)) return null;
  const half = {} as ThemeHalf;
  for (const token of THEME_TOKENS) {
    const hex = normalizeHex(value[token]);
    if (!hex) return null;
    half[token] = hexToCssColor(hex);
  }
  return repairHalf(half, mode);
}

function readStops(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const stops: string[] = [];
  for (const entry of value) {
    const hex = normalizeHex(entry);
    if (!hex) return null;
    stops.push(hex);
  }
  if (stops.length < MIN_GRADIENT_STOPS) return null;
  // More than four is a longer scene than the custom format can hold; the
  // extras are dropped rather than the whole backdrop, since the first four
  // still describe the same picture.
  return stops.slice(0, MAX_GRADIENT_STOPS);
}

function readAngle(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 160;
  return ((Math.round(value) % 360) + 360) % 360;
}

/**
 * A model's answer as something wearable, or a sentence saying why not.
 *
 * TOTAL BY CONSTRUCTION: every branch of every member is checked, and the two
 * things that are decoration rather than substance — the backdrop and the
 * accent — degrade to "absent" instead of failing the whole design. Only a
 * malformed HALF is fatal, because a theme missing a canvas is not a theme.
 */
export function applyDesign(result: unknown): DesignOutcome {
  if (!isRecord(result)) return { error: "The engine's model answered with something that is not a theme." };

  const light = readHalf(result.light, "light");
  const dark = readHalf(result.dark, "dark");
  if (!light || !dark) return { error: "The engine's model left colours out of that theme — try describing the look again." };

  const rawLabel = typeof result.label === "string" ? result.label.trim().replace(/\s+/g, " ") : "";
  const label = rawLabel.length > 0 ? rawLabel.slice(0, MAX_LABEL) : "Designed theme";

  const outcome: DesignSuccess = { definition: { label, light, dark } };

  const backdrop = isRecord(result.backdrop) ? result.backdrop : undefined;
  if (backdrop?.present === true) {
    const lightStops = readStops(backdrop.lightStops);
    const darkStops = readStops(backdrop.darkStops);
    if (lightStops && darkStops) {
      const angle = readAngle(backdrop.angle);
      outcome.backdropSpec = {
        light: { type: "linear", angle, stops: lightStops },
        dark: { type: "linear", angle, stops: darkStops },
      };
    }
  }

  if (typeof result.accent === "string" && (ACCENTS as readonly string[]).includes(result.accent)) {
    outcome.accent = result.accent as Accent;
  }

  return outcome;
}
