
import { cssColorToHex, TELAR_DARK, TELAR_LIGHT, type ThemeDefinition, type ThemeHalf } from "./theme-palettes";

type Rgba = { r: number; g: number; b: number; a: number };
type Rgb = { r: number; g: number; b: number };

const READABLE = 4.5;

const MID_LUMINANCE = 0.179;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

function toHex(color: Rgb): string {
  const channel = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

export function flattenOver(color: Rgba, base: Rgb): string {
  if (color.a >= 1) return toHex(color);
  return toHex({
    r: color.r * color.a + base.r * (1 - color.a),
    g: color.g * color.a + base.g * (1 - color.a),
    b: color.b * color.a + base.b * (1 - color.a),
  });
}

function relativeLuminance(color: Rgb): number {
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

function toRgb(value: string): Rgb {
  return parseVsCodeColor(cssColorToHex(value)) ?? parseVsCodeColor(value) ?? { r: 0, g: 0, b: 0, a: 1 };
}

export function isVsCodeThemeFile(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const hasWorkbenchColors = isRecord(value.colors) && Object.keys(value.colors).some((key) => key.includes("."));
  return hasWorkbenchColors || Array.isArray(value.tokenColors);
}

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
  return relativeLuminance(canvas) < MID_LUMINANCE ? "dark" : "light";
}

export type VsCodeHalf = { mode: "light" | "dark"; label: string; half: ThemeHalf };

export function vsCodeThemeToHalf(json: unknown): VsCodeHalf {
  if (!isRecord(json)) throw new Error("Theme files must contain a JSON object.");
  const colors = isRecord(json.colors) ? json.colors : {};

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

  const card = solidOver(canvas, "editorWidget.background") ?? floor.card;
  const popover = solidOver(canvas, "menu.background", "quickInput.background", "dropdown.background") ?? floor.popover;
  const codeSurface = solidOver(canvas, "textCodeBlock.background", "editorWidget.background");
  const secondary = codeSurface ?? floor.secondary;
  const muted = codeSurface ?? floor.muted;
  const accent = solidOver(canvas, "list.hoverBackground") ?? floor.accent;
  const sidebar = solidOver(canvas, "sideBar.background", "activityBar.background") ?? floor.sidebar;
  const sidebarAccent = solidOver(toRgb(sidebar), "list.inactiveSelectionBackground", "list.hoverBackground") ?? floor["sidebar-accent"];

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

export function vsCodeThemeToDefinition(json: unknown): Omit<ThemeDefinition, "id"> {
  const { mode, label, half } = vsCodeThemeToHalf(json);
  return {
    label,
    light: mode === "light" ? half : TELAR_LIGHT,
    dark: mode === "dark" ? half : TELAR_DARK,
  };
}
