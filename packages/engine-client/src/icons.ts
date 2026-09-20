/**
 * THE IDENTITY VOCABULARY — the closed set of icons, and the closed set of
 * colours, that anything a person NAMES may wear: a browser profile, a project,
 * whatever comes next.
 *
 * WHY A CLOSED SET AND NOT AN EMOJI FIELD. An emoji is a font's opinion: it
 * renders differently on every machine, it cannot take the app's own colour, and
 * a picker over the whole of Unicode is not a choice anyone can make. A lucide id
 * is a glyph this app already ships, drawn in `currentColor`, so the same profile
 * looks the same everywhere and a colour token actually colours it.
 *
 * THE IDS ARE LUCIDE'S OWN, kebab-case, exactly as `lucide-react` names them —
 * the renderer maps id → component (`apps/web/lib/telar-icons.tsx`), and nothing
 * stores a component. Storing a name means an install that upgrades lucide keeps
 * every icon a person chose.
 *
 * THE COLOURS ARE THE EIGHT `--subject-*` HUES, and the law travels with them:
 * an identity hue says WHOSE something is, never how urgent.
 *
 * PURE DATA. No zod schema is imported by anything that only needs the list, and
 * nothing here reaches a DOM, a clock or a framework.
 */
import { z } from "zod";

/**
 * FORTY GLYPHS, GROUPED BY WHAT PEOPLE ACTUALLY NAME THINGS AFTER — work and
 * places, making and running, money and study, nature and weather, marks.
 *
 * Forty is a deliberate ceiling: a grid a person can scan in one look and pick
 * from without searching. Adding one is cheap; the picker grows a row.
 */
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
