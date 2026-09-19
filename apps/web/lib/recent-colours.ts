/**
 * THE COLOURS ALREADY IN PLAY — what a stop should be offered before the OS
 * picker is (#471).
 *
 * A GRADIENT IS MADE OF THE APP'S OWN COLOURS more often than of new ones. The
 * second stop usually wants the first one's hue; the layer over the base usually
 * wants the base; a highlight usually wants the accent. Every one of those was
 * a trip through a system colour dialog to retype a hex the app already knows,
 * so the row of chips is not a convenience on top of the picker — it is the
 * path most edits should take, with the picker left for the colour that is
 * genuinely new.
 *
 * FIXED ONES FIRST, THEN WHAT YOU TOUCHED. The two bases and the accent are
 * always there and always in the same place, because a control that reorders
 * itself is a control you have to read every time. The recents follow,
 * most-recent-first, which is the only order that makes the eighth one worth
 * keeping.
 *
 * THE RECENTS ARE THIS SESSION'S, AND DELIBERATELY NOT STORED. They are a
 * record of what your hands just did, which is exactly as long as it stays
 * useful; a list persisted across launches would offer you the colours of a
 * composition you have since thrown away, and it would be one more thing in
 * localStorage for the composer to keep in step.
 */

import { normaliseColourText } from "./colour-field";

/** "The last eight colours used across stops in this session" — the owner's
 *  number. Eight is about two rows of chips at this size, which is as many as
 *  can be scanned without reading. */
export const RECENT_COLOUR_LIMIT = 8;

/**
 * One colour remembered: at the front, once, and never past the cap.
 *
 * REAPPLYING AN OLD COLOUR MOVES IT BACK TO THE FRONT rather than doing
 * nothing, because that IS the evidence it is still what you are working with —
 * a list that only counted first uses would push a colour you keep coming back
 * to off the end.
 *
 * A value that is not a colour is dropped rather than stored, so the list can
 * be rendered straight into swatches without every reader re-checking.
 */
export function rememberColour(list: readonly string[], colour: string): string[] {
  const hex = normaliseColourText(colour);
  if (!hex) return [...list];
  return [hex, ...list.filter((entry) => entry !== hex)].slice(0, RECENT_COLOUR_LIMIT);
}

export type ColourChip = { color: string; label: string };

/**
 * The whole row, in the order it is drawn: both bases, the accent, then the
 * recents.
 *
 * DUPLICATES COLLAPSE TOWARDS THE NAMED ONES. Picking the base as a stop colour
 * puts it in the recents, and drawing it twice would say there are two of it —
 * so a recent that is already a named chip is dropped, and the chip that
 * survives is the one that says what the colour IS. The recents keep their own
 * order among themselves.
 *
 * A state's base may be any CSS colour (the composer stores what the picker
 * gave it); anything unparseable is left out rather than drawn as grey.
 */
export function colourChips(input: { light: string; dark: string; accent: string; recent: readonly string[] }): ColourChip[] {
  const named: ColourChip[] = [
    { color: input.light, label: "Light base" },
    { color: input.dark, label: "Dark base" },
    { color: input.accent, label: "Accent" },
  ];
  const chips: ColourChip[] = [];
  const seen = new Set<string>();
  for (const chip of named) {
    const hex = normaliseColourText(chip.color);
    if (!hex || seen.has(hex)) continue;
    seen.add(hex);
    chips.push({ color: hex, label: chip.label });
  }
  for (const colour of input.recent) {
    const hex = normaliseColourText(colour);
    if (!hex || seen.has(hex)) continue;
    seen.add(hex);
    chips.push({ color: hex, label: hex });
  }
  return chips;
}

/* ── The session's own list ──────────────────────────────────────────────── */

/**
 * Read through `useSyncExternalStore` rather than React state, for the reason
 * the editor's wrap preference is: the list outlives the component. A stop
 * editor closes whenever its layer is moved or another one is opened, and a
 * recents row that emptied itself every time a layer moved would be a worse
 * offer than no row at all.
 */
const EMPTY: readonly string[] = [];
const listeners = new Set<() => void>();
let recent: readonly string[] = EMPTY;

export function rememberStopColour(colour: string): void {
  const next = rememberColour(recent, colour);
  // Identity is the snapshot's contract: an unparseable value, or the colour
  // already at the front, must not make `useSyncExternalStore` re-render.
  if (next.length === recent.length && next.every((entry, index) => entry === recent[index])) return;
  recent = next;
  for (const listener of listeners) listener();
}

export function subscribeRecentColours(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function recentColoursSnapshot(): readonly string[] {
  return recent;
}

/** The server has nothing to remember, and hydration agrees with it. */
export function serverRecentColoursSnapshot(): readonly string[] {
  return EMPTY;
}

/**
 * Tests only: the list is a module-level session record with no way back to
 * empty, which is right for the app and wrong for a test file.
 *
 * SILENT ON PURPOSE. It is called between mounts to set up a fresh one, and a
 * test file that shares this module with another file's still-mounted tree
 * would otherwise be re-rendering somebody else's component from its setup.
 */
export function forgetRecentColours(): void {
  recent = EMPTY;
}
