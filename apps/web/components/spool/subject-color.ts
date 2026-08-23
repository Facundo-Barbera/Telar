/**
 * TOKEN → CSS VARIABLE, AND NOTHING ELSE — the one door to the identity hues.
 *
 * `SpoolSubjectColor` is a closed set of NAMES the engine stores; the actual
 * oklch values live in `globals.css` (`--subject-*`, one block per theme,
 * carrying the law: identity hues say WHOSE something is, never how urgent).
 * This helper is deliberately the whole mapping and deliberately PURE — no
 * state, no clock, no item ever reaches it — so no renderer can compose a hue
 * from a deadline, a tier or a slip. Unknown or absent collapses to one
 * neutral value: a subject without a colour is an ordinary subject, and its
 * dot is a quiet grey, not a missing pixel.
 */
import { SpoolSubjectColor } from "@telar/engine-client";

/** The closed set, in the order the swatch control offers it. Derived from
 *  the engine's own enum so the two cannot drift. */
export const SUBJECT_COLORS: readonly SpoolSubjectColor[] = SpoolSubjectColor.options;

/**
 * The neutral fallback — `--input`, the app's opaque mid-grey in both themes,
 * because the fallback dot must read as "no colour chosen" rather than as a
 * ninth hue or as nothing at all.
 */
const NEUTRAL = "var(--input)";

/** A stored token (or anything else) → the CSS variable a dot paints with. */
export function subjectColorVar(color: string | undefined | null): string {
  return color && (SUBJECT_COLORS as readonly string[]).includes(color) ? `var(--subject-${color})` : NEUTRAL;
}
