/**
 * Normalises typed colours to `#rrggbb`; parsing is `parseCssColor`'s job. Also accepts hex
 * without its `#`. Unparseable input yields undefined so the field can snap back.
 */

import { parseCssColor } from "./theme-palettes";

/** Hex without its `#` — three, four, six or eight digits, the same lengths
 *  `parseCssColor` accepts with one. */
const BARE_HEX = /^([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i;

/** A typed colour as lowercase `#rrggbb` (so equal stops compare equal), or undefined. */
export function normaliseColourText(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = parseCssColor(BARE_HEX.test(trimmed) ? `#${trimmed}` : trimmed);
  return parsed?.toLowerCase();
}
