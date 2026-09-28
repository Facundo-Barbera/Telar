"use client";

import type { ThemeHalf, ThemeToken } from "@telar/engine-client";

export { TELAR_DARK, TELAR_LIGHT, THEME_TOKENS, type ThemeHalf, type ThemeToken } from "@telar/engine-client";

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

export type ThemeDefinition = {
  id: string;
  label: string;
  light: ThemeHalf;
  dark: ThemeHalf;
};

function linearToSrgb(v: number): number {
  const s = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, s)) * 255);
}

function toHex(channels: readonly number[]): string {
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function oklchComponent(raw: string, percentBasis: number): number {
  if (raw === "none") return 0;
  const number = Number.parseFloat(raw);
  if (!Number.isFinite(number)) return Number.NaN;
  return raw.endsWith("%") ? (number / 100) * percentBasis : number;
}

function hueDegrees(raw: string): number {
  if (raw === "none") return 0;
  const number = Number.parseFloat(raw);
  if (!Number.isFinite(number)) return Number.NaN;
  if (raw.endsWith("turn")) return number * 360;
  if (raw.endsWith("grad")) return number * 0.9;
  if (raw.endsWith("rad")) return (number * 180) / Math.PI;
  return number;
}

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
    const rgba = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(resolved);
    if (!rgba) return undefined;
    return toHex([1, 2, 3].map((index) => Math.min(255, Math.max(0, Math.round(Number(rgba[index]))))));
  } catch {
    return undefined;
  }
}

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

  const hex = /^#([\da-f]{3,8})$/i.exec(trimmed);
  if (hex) {
    const digits = hex[1];
    if (digits.length === 3 || digits.length === 4) {
      return `#${[...digits.slice(0, 3)].map((digit) => digit + digit).join("")}`.toLowerCase();
    }
    if (digits.length === 6 || digits.length === 8) return `#${digits.slice(0, 6)}`.toLowerCase();
  }

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

export function cssColorToHex(value: string): string {
  return parseCssColor(value) ?? "#808080";
}

export function hexToCssColor(hex: string): string {
  return hex;
}
