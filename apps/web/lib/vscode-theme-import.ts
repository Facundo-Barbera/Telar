/**
 * VS CODE THEMES, READ AS ONE OF TELAR'S HALVES.
 *
 * A `*-color-theme.json` describes an EDITOR's chrome: a few hundred dotted
 * workbench keys, most of them unset, alpha overlays everywhere, and no notion
 * of a card or a chip. Telar's model is sixteen surface tokens, each already
 * contrast-solved against the others. So the conversion is deliberately
 * lossy in one direction only:
 *
 *   FLOOR   — start from TELAR_LIGHT/TELAR_DARK. Every token already reads.
 *   OVERLAY — replace only what the file actually specifies, alpha-flattened
 *             over the surface that token sits on (VS Code overlays are
 *             translucent; our tokens are opaque).
 *   REPAIR  — a foreground only wins when it clears 4.5:1 on ITS OWN resolved
 *             surface. Overriding a background can strand the floor's text
 *             colour, and that is exactly the case the repair exists for.
 *
 * A file is ONE half — its `type` (or its editor background's luminance) says
 * which. The other half stays Telar's base verbatim rather than being invented
 * by inverting the first: the halves are independently wearable, so a user who
 * wants both pairs two imports.
 *
 * Ported from t3 code's importer, minus the wide-gamut `color()` path (Telar's
 * editor speaks hex and oklch, and the sRGB clip that path buys is not worth
 * the matrices here).
 */

import { compositionFromV1, type Look } from "@telar/engine-client";
import { cssColorToHex, TELAR_DARK, TELAR_LIGHT, type ThemeDefinition, type ThemeHalf } from "./theme-palettes";

type Rgba = { r: number; g: number; b: number; a: number };
type Rgb = { r: number; g: number; b: number };

/** Text is legible at 4.5:1 (WCAG AA for body copy) — the bar every foreground
 *  in this file has to clear on the surface it lands on. */
const READABLE = 4.5;

/** WCAG's own light/dark split point: the luminance at which #000 and #fff
 *  contrast equally. Also how an untyped theme's mode is guessed. */
const MID_LUMINANCE = 0.179;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** VS Code accepts #RGB, #RGBA, #RRGGBB, and #RRGGBBAA. */
export function parseVsCodeColor(value: unknown): Rgba | null {
  if (typeof value !== "string") return null;
  const hex = value.trim().replace(/^#/, "");
  if (!/^(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex)) return null;
  const expand = (part: string) => Number.parseInt(part + part, 16);
  if (hex.length <= 4) {
    return {
      r: expand(hex[0]!),
      g: expand(hex[1]!),
      b: expand(hex[2]!),
      a: hex.length === 4 ? expand(hex[3]!) / 255 : 1,
    };
  }
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
    a: hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1,
  };
}

export function toHex(color: Rgb): string {
  const channel = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

/** Overlays are semi-transparent in VS Code; our tokens are opaque, so they
 *  are composited onto whatever surface they sit on. */
export function flattenOver(color: Rgba, base: Rgb): string {
  if (color.a >= 1) return toHex(color);
  return toHex({
    r: color.r * color.a + base.r * (1 - color.a),
    g: color.g * color.a + base.g * (1 - color.a),
    b: color.b * color.a + base.b * (1 - color.a),
  });
}

export function relativeLuminance(color: Rgb): number {
  const channel = (value: number) => {
    const ratio = value / 255;
    return ratio <= 0.03928 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

export function contrastRatio(first: Rgb, second: Rgb): number {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Any CSS colour Telar stores, as channels: the floor tokens are oklch, so
 *  they go through the editor's own converter before being measured. */
function toRgb(value: string): Rgb {
  return parseVsCodeColor(cssColorToHex(value)) ?? parseVsCodeColor(value) ?? { r: 0, g: 0, b: 0, a: 1 };
}

/**
 * A VS Code theme is recognised by its workbench colours: the keys are dotted
 * paths (`editor.background`), which Telar's own theme files never use.
 */
export function isVsCodeThemeFile(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const hasWorkbenchColors = isRecord(value.colors) && Object.keys(value.colors).some((key) => key.includes("."));
  return hasWorkbenchColors || Array.isArray(value.tokenColors);
}

/** Extension `name` fields are often package slugs; read them as words. */
export function humanizeThemeName(raw: string): string {
  const trimmed = raw.trim();
  if (/\s/.test(trimmed) || !/[-_.]/.test(trimmed)) return trimmed;
  return trimmed
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function resolveName(value: Record<string, unknown>): string {
  // Judge candidates by their humanized form: a displayName of "---"
  // humanizes to nothing and must fall through to the name.
  for (const candidate of [value.displayName, value.name]) {
    if (typeof candidate !== "string") continue;
    const humanized = humanizeThemeName(candidate);
    if (humanized.length > 0) return humanized.slice(0, 48);
  }
  return "VS Code theme";
}

function resolveMode(value: Record<string, unknown>, canvas: Rgb): "light" | "dark" {
  const type = typeof value.type === "string" ? value.type.toLowerCase() : null;
  if (type === "light" || type === "hc-light") return "light";
  if (type === "dark" || type === "hc-black") return "dark";
  // Unlabelled themes (and the odd custom `type`) follow the editor surface.
  return relativeLuminance(canvas) < MID_LUMINANCE ? "dark" : "light";
}

export type VsCodeHalf = { mode: "light" | "dark"; label: string; half: ThemeHalf };

/** The half a VS Code file describes, complete: floor, then overlay, then the
 *  contrast repair on every foreground. */
export function vsCodeThemeToHalf(json: unknown): VsCodeHalf {
  if (!isRecord(json)) throw new Error("Theme files must contain a JSON object.");
  const colors = isRecord(json.colors) ? json.colors : {};

  /** First key that carries a usable colour, in priority order. */
  const pick = (...keys: ReadonlyArray<string>): Rgba | null => {
    for (const key of keys) {
      const parsed = parseVsCodeColor(colors[key]);
      if (parsed) return parsed;
    }
    return null;
  };
  const solidOver = (base: Rgb, ...keys: ReadonlyArray<string>): string | null => {
    const parsed = pick(...keys);
    return parsed ? flattenOver(parsed, base) : null;
  };

  const canvasColor = pick("editor.background", "editorPane.background");
  if (!canvasColor) {
    throw new Error('That VS Code theme has no "editor.background" color, so there is nothing to build a palette from.');
  }
  const canvas: Rgb = { r: canvasColor.r, g: canvasColor.g, b: canvasColor.b };
  const canvasHex = toHex(canvas);
  const mode = resolveMode(json, canvas);
  const floor = mode === "light" ? TELAR_LIGHT : TELAR_DARK;

  // Backgrounds first: every foreground below is judged against the surface
  // that actually won here, not against the one the floor was solved for.
  const card = solidOver(canvas, "editorWidget.background") ?? floor.card;
  const popover = solidOver(canvas, "menu.background", "quickInput.background", "dropdown.background") ?? floor.popover;
  const codeSurface = solidOver(canvas, "textCodeBlock.background", "editorWidget.background");
  const secondary = codeSurface ?? floor.secondary;
  const muted = codeSurface ?? floor.muted;
  const accent = solidOver(canvas, "list.hoverBackground") ?? floor.accent;
  const sidebar = solidOver(canvas, "sideBar.background", "activityBar.background") ?? floor.sidebar;
  // The rail's hover sits ON THE RAIL, so it flattens over the resolved
  // sidebar — over the canvas it would be a different colour entirely.
  const sidebarAccent = solidOver(toRgb(sidebar), "list.inactiveSelectionBackground", "list.hoverBackground") ?? floor["sidebar-accent"];

  /**
   * A foreground only wins when it stays readable on the surface it lands on;
   * a theme tuned for its own chrome can be unreadable on ours. The floor gets
   * the same test — it was solved against Telar's surface, and the file may
   * have just replaced that — before the greyscale end-stop takes over.
   */
  const readable = (surface: string, candidate: string | null, fallback: string): string => {
    const surfaceRgb = toRgb(surface);
    const clears = (color: string) => contrastRatio(toRgb(color), surfaceRgb) >= READABLE;
    if (candidate && clears(candidate)) return candidate;
    if (clears(fallback)) return fallback;
    return relativeLuminance(surfaceRgb) < MID_LUMINANCE ? "#ffffff" : "#000000";
  };

  const foreground = readable(canvasHex, solidOver(canvas, "editor.foreground", "foreground"), floor.foreground);

  return {
    mode,
    label: resolveName(json),
    half: {
      background: canvasHex,
      foreground,
      card,
      // The chrome keys for these surfaces have no text colour of their own,
      // so the canvas text carries over — repaired per surface.
      "card-foreground": readable(card, foreground, floor["card-foreground"]),
      popover,
      "popover-foreground": readable(popover, foreground, floor["popover-foreground"]),
      secondary,
      "secondary-foreground": readable(secondary, foreground, floor["secondary-foreground"]),
      muted,
      "muted-foreground": readable(canvasHex, solidOver(canvas, "descriptionForeground", "disabledForeground"), floor["muted-foreground"]),
      accent,
      "accent-foreground": readable(accent, foreground, floor["accent-foreground"]),
      border: solidOver(canvas, "panel.border", "editorGroup.border", "contrastBorder") ?? floor.border,
      input: solidOver(canvas, "input.border", "dropdown.border") ?? floor.input,
      sidebar,
      "sidebar-accent": sidebarAccent,
    },
  };
}

/**
 * One imported file as a whole theme. The half it does not describe stays
 * Telar's base verbatim — inventing a dark half from a light file would be a
 * guess wearing the theme's name. Pair two imports to get both.
 */
export function vsCodeThemeToDefinition(json: unknown): Omit<ThemeDefinition, "id"> {
  const { mode, label, half } = vsCodeThemeToHalf(json);
  return {
    label,
    light: mode === "light" ? half : TELAR_LIGHT,
    dark: mode === "dark" ? half : TELAR_DARK,
  };
}

/**
 * AN IMPORT, AS A LOOK — which is what an imported palette becomes now (#471).
 *
 * There is nowhere else for one to land: the theme library is gone and the
 * gallery of Looks is the only preset system. The composition it arrives as is
 * the same one `compositionFromV1` gives every pre-composition Look — the base
 * is the canvas the file described, and every one of the sixteen tokens is
 * PINNED as a hand-set override.
 *
 * PINNED, AND THAT IS THE POINT RATHER THAN A SHORTCUT. A VS Code theme is a
 * palette somebody tuned token by token; deriving fifteen of them from its
 * canvas colour would import the file's hue and throw away its work. The base
 * still opens on the right colour, and clearing any token hands that one back
 * to it.
 */
export function vsCodeThemeToLook(json: unknown, id: string, appearance: Omit<Look, "version" | "id" | "label" | "composition" | "images">): Look {
  const definition = vsCodeThemeToDefinition(json);
  const { composition, images } = compositionFromV1({ light: definition.light, dark: definition.dark }, { kind: "none" });
  return { version: 2, id, label: definition.label, composition, images, ...appearance };
}
