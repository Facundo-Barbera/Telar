import { z } from "zod";

export const TELAR_ICONS = [
  // Work, people, places
  "globe",
  "briefcase",
  "house",
  "building-2",
  "user-round",
  "users-round",
  "compass",
  "map",
  // Making and running
  "code",
  "terminal",
  "database",
  "server",
  "cloud",
  "box",
  "layers",
  "cpu",
  "bot",
  "wrench",
  "hammer",
  "puzzle",
  // Craft
  "pen-tool",
  "palette",
  "camera",
  "music",
  "film",
  "feather",
  // Money and study
  "shopping-cart",
  "credit-card",
  "book",
  "graduation-cap",
  "flask-conical",
  // Nature and weather
  "leaf",
  "tree-pine",
  "sun",
  "moon",
  "flame",
  // Marks
  "star",
  "heart",
  "shield",
  "rocket",
] as const;

/** One icon id, validated. Anything else is not an icon this app can draw. */
export const TelarIcon = z.enum(TELAR_ICONS);
export type TelarIcon = z.infer<typeof TelarIcon>;

/** Whether a stored string is still an icon this app ships. A record written by
 *  an older or newer build is read, not thrown away — the renderer falls back. */
export function isTelarIcon(value: unknown): value is TelarIcon {
  return typeof value === "string" && (TELAR_ICONS as readonly string[]).includes(value);
}

/**
 * The eight identity hues, in the order every swatch control offers them. The
 * oklch values live in `globals.css` as `--subject-*`, one block per theme; this
 * list is only the names.
 */
export const IDENTITY_COLORS = ["plum", "sea", "moss", "amber", "slate", "rose", "sky", "sand"] as const;

export const IdentityColor = z.enum(IDENTITY_COLORS);
export type IdentityColor = z.infer<typeof IdentityColor>;

export function isIdentityColor(value: unknown): value is IdentityColor {
  return typeof value === "string" && (IDENTITY_COLORS as readonly string[]).includes(value);
}
