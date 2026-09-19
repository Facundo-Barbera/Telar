"use client";

/**
 * THE SURFACE VOCABULARY — sixteen tokens, what each one paints, and the colour
 * conversion every picker needs.
 *
 * WHAT THIS FILE WAS, AND WHY THE STORE IS GONE (#471). It held a LIBRARY:
 * built-in palettes, custom ones, an active PAIR naming which palette owned
 * light and which owned dark, a compiler from that pair to a stylesheet, and
 * the cache the pre-paint script injected. "Themes should not exist, there
 * should be default settings for the composer." So there is no theme object to
 * pick any more — lib/composition.ts holds a base per colour state and DERIVES
 * these sixteen from it, compiles the stylesheet, and owns the cache. The
 * defaults that used to be built-in themes are built-in Looks
 * (lib/built-in-looks.ts); the old keys are read forward once
 * (lib/legacy-appearance.ts) and then dropped.
 *
 * WHAT STAYED IS WHAT WAS NEVER ABOUT THE LIBRARY: the names of the tokens, a
 * phrase saying where each one paints, and `cssColorToHex` / `hexToCssColor` —
 * which every colour input in the app goes through, and which the VS Code
 * importer and the base derivation both measure with.
 */

import type { ThemeHalf, ThemeToken } from "@telar/engine-client";

/**
 * THE TOKENS AND THE BASE HALVES LIVE IN @telar/engine-client: a `Look` on the
 * wire carries hand-set overrides over exactly this vocabulary, and the parser
 * that reads one fills its gaps from exactly these values. Re-exported so no
 * importer changed.
 */
export { TELAR_DARK, TELAR_LIGHT, THEME_TOKENS, type ThemeHalf, type ThemeToken } from "@telar/engine-client";

/**
 * WHERE EACH TOKEN ACTUALLY PAINTS, in one phrase (#471).
 *
 * The sixteen rows carried a NAME and nothing else — "Hover", "Chip", "Rail
 * hover" — and the owner's complaint about this editor was exactly that: "you
 * basically need to know how each component of each surface reacts to these".
 * A name is only legible to somebody who already knows the token; a phrase
 * naming the thing on screen it colours is legible to anybody who has looked at
 * the app. These are the app's own surfaces, not the CSS variable restated.
 */
export const THEME_TOKEN_HINTS: Record<ThemeToken, string> = {
  background: "The canvas the whole window sits on",
  foreground: "Body text on that canvas",
  card: "Raised surfaces — cards, panels, dialogs",
  "card-foreground": "Text on a card",
  popover: "Menus, dropdowns and tooltips",
  "popover-foreground": "Text inside a menu",
  secondary: "Chips, badges and quiet buttons",
  "secondary-foreground": "Text on a chip",
  muted: "Quiet fills — empty states, stripes",
  "muted-foreground": "Hints, captions and secondary text",
  accent: "A row under the pointer",
  "accent-foreground": "Text on a row under the pointer",
  border: "Every hairline in the app",
  input: "The edge of a text field",
  sidebar: "The rail down the side",
  "sidebar-accent": "A rail row under the pointer",
};

/**
 * WHICH SURFACE EACH FOREGROUND IS JUDGED AGAINST.
 *
 * `muted-foreground` is secondary text on the CANVAS (hints, timestamps) rather
 * than on `muted`, which is why it is not the pairing the token names suggest.
 * A fact about what the tokens MEAN, so it lives beside the phrases saying
 * where they paint rather than inside whichever tool measures with it — the
 * composer's token rows show a live ratio from this table, and the VS Code
 * importer repairs against the same pairs.
 */
export const FOREGROUND_SURFACES: ReadonlyArray<readonly [ThemeToken, ThemeToken]> = [
  ["foreground", "background"],
  ["card-foreground", "card"],
  ["popover-foreground", "popover"],
  ["secondary-foreground", "secondary"],
  ["muted-foreground", "background"],
  ["accent-foreground", "accent"],
];

export const THEME_TOKEN_LABELS: Record<ThemeToken, string> = {
  background: "Canvas",
  foreground: "Text",
  card: "Card",
  "card-foreground": "Card text",
  popover: "Popover",
  "popover-foreground": "Popover text",
  secondary: "Chip",
  "secondary-foreground": "Chip text",
  muted: "Muted",
  "muted-foreground": "Muted text",
  accent: "Hover",
  "accent-foreground": "Hover text",
  border: "Border",
  input: "Field border",
  sidebar: "Rail",
  "sidebar-accent": "Rail hover",
};

/**
 * TWO HALVES AND A NAME — what arrives from OUTSIDE this app.
 *
 * It is no longer a stored object anybody picks: the composer holds a
 * composition and derives its sixteen tokens from a base (lib/composition.ts),
 * so nothing in this build SAVES one of these. What still produces one is an
 * import — a VS Code `*-color-theme.json`, or a photograph read through
 * palette-from-image — and lib/vscode-theme-import.ts turns it into a Look on
 * the way in. So this is an interchange shape, and the tokens above are its
 * vocabulary.
 */
export type ThemeDefinition = {
  id: string;
  label: string;
  light: ThemeHalf;
  dark: ThemeHalf;
};

// ── Colour conversion for the editor's pickers ──────────────────────────────
// <input type="color"> speaks hex only; the built-ins speak oklch. Ported from
// the standard OKLab matrices (the same maths t3 code's preview uses).

function linearToSrgb(v: number): number {
  const s = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, s)) * 255);
}

function toHex(channels: readonly number[]): string {
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * One oklch component. Each may be a number, a percentage against its own
 * basis, or `none` — all three are valid CSS and only the first was read, so
 * `oklch(96% 0 0)` (a perfectly ordinary way to write a canvas) fell through
 * to the grey below.
 */
function oklchComponent(raw: string, percentBasis: number): number {
  if (raw === "none") return 0;
  const number = Number.parseFloat(raw);
  if (!Number.isFinite(number)) return Number.NaN;
  return raw.endsWith("%") ? (number / 100) * percentBasis : number;
}

/** Degrees, from any of the four angle units CSS allows. */
function hueDegrees(raw: string): number {
  if (raw === "none") return 0;
  const number = Number.parseFloat(raw);
  if (!Number.isFinite(number)) return Number.NaN;
  if (raw.endsWith("turn")) return number * 360;
  if (raw.endsWith("grad")) return number * 0.9;
  if (raw.endsWith("rad")) return (number * 180) / Math.PI;
  return number;
}

/**
 * ANYTHING CSS CAN PARSE, RESOLVED BY THE THING THAT PARSES CSS.
 *
 * A canvas context's `fillStyle` is a colour parser with a serialiser attached:
 * assigning an invalid value is a no-op by spec, so a sentinel tells "did not
 * parse" apart from "parsed to something". This is what catches named colours,
 * `hsl()`, `lab()`, `color()` and every syntax added after this file was
 * written, without any of them needing a branch here.
 *
 * Undefined outside a browser (the tests, and any pre-paint path) — the
 * caller's own branches cover everything this palette actually stores.
 */
function resolveThroughCss(value: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  try {
    const context = document.createElement("canvas").getContext("2d");
    if (!context) return undefined;
    const sentinel = "#010203";
    context.fillStyle = sentinel;
    context.fillStyle = value;
    const resolved = context.fillStyle;
    if (typeof resolved !== "string" || resolved === sentinel) return undefined;
    if (/^#[\da-f]{6}$/i.test(resolved)) return resolved.toLowerCase();
    // Translucent values serialise as `rgba(r, g, b, a)`; the alpha is dropped
    // for the same reason it is everywhere else here — see below.
    const rgba = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(resolved);
    if (!rgba) return undefined;
    return toHex([1, 2, 3].map((index) => Math.min(255, Math.max(0, Math.round(Number(rgba[index]))))));
  } catch {
    return undefined;
  }
}

/**
 * A CSS colour as six-digit hex, or NOTHING when it is not a colour at all.
 *
 * THE STRICT HALF OF `cssColorToHex`, split out for the one caller that has to
 * tell the two apart (#471): a field somebody TYPES into. Everywhere else reads
 * a value this app itself stored, so "it did not parse" is a bug rather than an
 * input, and a fallback grey is the kindest thing to show. In a text field it is
 * the opposite — typing `bananas` and getting a real grey stop is the field
 * quietly accepting nonsense — so the composer's colour field wants the
 * undefined and does the snapping back itself.
 *
 * ALPHA IS DROPPED, AND THAT IS A PROPERTY OF THE WIDGET, NOT A BUG HERE. There
 * is no way to show 10% white in a colour input. `oklch(1 0 0 / 10%)` reports
 * as `#ffffff`, which is the honest answer to "what colour is this"; the alpha
 * survives in the stored value and is only lost if the reader actually picks a
 * new colour through that swatch, which is an edit.
 */
export function parseCssColor(value: string): string | undefined {
  const trimmed = value.trim();

  const oklch = /^oklch\(\s*(none|[\d.]+%?)\s+(none|[\d.]+%?)\s+(none|-?[\d.]+(?:deg|rad|grad|turn)?)/i.exec(trimmed);
  if (oklch) {
    const l = oklchComponent(oklch[1], 1);
    const chroma = oklchComponent(oklch[2], 0.4);
    const degrees = hueDegrees(oklch[3]);
    if (Number.isFinite(l) && Number.isFinite(chroma) && Number.isFinite(degrees)) {
      const hue = (degrees * Math.PI) / 180;
      const a = chroma * Math.cos(hue);
      const b = chroma * Math.sin(hue);
      const lp = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
      const mp = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
      const sp = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
      return toHex([
        linearToSrgb(4.0767416621 * lp - 3.3077115913 * mp + 0.2309699292 * sp),
        linearToSrgb(-1.2684380046 * lp + 2.6097574011 * mp - 0.3413193965 * sp),
        linearToSrgb(-0.0041960863 * lp - 0.7034186147 * mp + 1.707614701 * sp),
      ]);
    }
  }

  // `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` — the shorthands expand, the alpha
  // halves are cut off.
  const hex = /^#([\da-f]{3,8})$/i.exec(trimmed);
  if (hex) {
    const digits = hex[1];
    if (digits.length === 3 || digits.length === 4) {
      return `#${[...digits.slice(0, 3)].map((digit) => digit + digit).join("")}`.toLowerCase();
    }
    if (digits.length === 6 || digits.length === 8) return `#${digits.slice(0, 6)}`.toLowerCase();
  }

  // `rgb()` / `rgba()`, in either the comma or the space form, with numbers or
  // percentages — the syntax the VS Code theme importer meets most often.
  const rgb = /^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)/i.exec(trimmed);
  if (rgb) {
    const channels = [1, 2, 3].map((index) => {
      const raw = rgb[index];
      const number = Number.parseFloat(raw);
      const scaled = raw.endsWith("%") ? (number / 100) * 255 : number;
      return Math.min(255, Math.max(0, Math.round(scaled)));
    });
    if (channels.every(Number.isFinite)) return toHex(channels);
  }

  return resolveThroughCss(trimmed);
}

/**
 * A CSS colour as the six-digit hex `<input type="color">` insists on.
 *
 * IT MUST ALWAYS RETURN `#rrggbb`. Most callers put the result straight into an
 * `<input type="color">`, whose value sanitiser rejects anything else and shows
 * black — so "return the original when it is exotic" would trade a wrong colour
 * for a wrong colour AND a broken swatch. `parseCssColor` above exists to make
 * the last-resort grey unreachable in practice instead.
 *
 * It used to be two branches — a strict oklch shape, and literal `#rrggbb` —
 * and everything else became `#808080`. That grey is not a display artefact:
 * lib/studio-draft.ts fingerprints a draft through this function and
 * lib/vscode-theme-import.ts reads imported colours through it, so a value it
 * could not parse became a real grey downstream. `oklch(96% 0 0)`, `#abc`,
 * `rgb(20 20 20)` and every named colour all took that path.
 */
export function cssColorToHex(value: string): string {
  return parseCssColor(value) ?? "#808080";
}

/** Hex straight through — CSS accepts it, and round-tripping user picks
 *  through oklch would drift them. */
export function hexToCssColor(hex: string): string {
  return hex;
}
