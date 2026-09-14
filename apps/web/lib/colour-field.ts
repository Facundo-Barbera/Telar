/**
 * WHAT A PERSON MAY TYPE INTO A COLOUR FIELD, and what lands (#471).
 *
 * THE FIELD IS A PARSER, NOT A FORMAT. Every colour this app stores is written
 * back as `#rrggbb` — that is what `<input type="color">` shows and what a stop
 * carries — but what somebody has in their clipboard is whatever the place they
 * copied it from writes: `#1e1e2e` from a theme file, `#abc` from a stylesheet,
 * `oklch(0.68 0.16 264)` from this app's own globals.css. Refusing the last two
 * would mean a reader who can SEE the value in the token rows cannot paste it
 * into a stop.
 *
 * SO PARSING IS `parseCssColor`'S JOB AND NORMALISING IS THIS FILE'S. The one
 * thing added here belongs to the field rather than to the colour model: hex
 * with the `#` left off, because typing it is how people type hex.
 *
 * NOTHING MEANS NOTHING. A field commits on blur, so "did not parse" has to be
 * distinguishable from a colour — an unparseable value snaps the field back to
 * what the stop already had rather than becoming a real grey.
 */

import { parseCssColor } from "./theme-palettes";

/** Hex without its `#` — three, four, six or eight digits, the same lengths
 *  `parseCssColor` accepts with one. */
const BARE_HEX = /^([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i;

/**
 * A typed colour as `#rrggbb`, or undefined when it is not one.
 *
 * Case is normalised down: two stops that are the same colour must compare
 * equal, and the recent-colours list dedupes on the string.
 */
export function normaliseColourText(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = parseCssColor(BARE_HEX.test(trimmed) ? `#${trimmed}` : trimmed);
  return parsed?.toLowerCase();
}
