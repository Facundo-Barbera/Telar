/**
 * THE LANGUAGE, IN THE TWO OR THREE CHARACTERS A PILL HAS ROOM FOR (#561).
 *
 * The indicator at the caret is the size of the caret. There is no room for
 * "Spanish (Latin America)" in it, and no need: the person reading it is the
 * person who chose it, and what they want to know at a glance is which of the
 * two settings they are dictating under right now — not the full name of a
 * language they are in the middle of speaking.
 *
 * SO IT IS THE CODE, UPPER-CASED. `es` reads as ES, `pt-BR` as PT-BR. That is
 * what macOS and iOS put in their own dictation badge, and it is the shortest
 * thing that is still unambiguous.
 *
 * AND `multi` READS AS "AUTO". The code is the vendor's word; AUTO is the
 * setting's own word for it, and it is what the picker calls it ("Automatic").
 * "MULTI" in a badge would be a third name for one thing, and the one name a
 * reader has never seen on a screen.
 */

import { DICTATION_AUTOMATIC } from "./automatic";

/** What `multi` is called where there are four characters to say it in. */
export const DICTATION_AUTOMATIC_BADGE = "AUTO";

export function languageBadge(code: string): string {
  const trimmed = code.trim();
  // AN EMPTY CODE READS AS AUTO rather than as an empty badge. It should not
  // happen — the engine answers `multi` for a Mac that has never been told —
  // but a pill with nothing in it would be a worse way to find that out than a
  // pill that says what is actually going to be transcribed.
  if (!trimmed) return DICTATION_AUTOMATIC_BADGE;
  return trimmed === DICTATION_AUTOMATIC ? DICTATION_AUTOMATIC_BADGE : trimmed.toUpperCase();
}
