/**
 * TAGS — the free-text labels items and notes already carry, given exactly two
 * hand verbs: list what is in use, and rename one (which merges it when the
 * name already belongs to another tag).
 *
 * ── WHY THIS FILE, AND NOT A THIRD PLACE TAGS ARE VALIDATED ──────────────────
 * `assertTags` (`store.ts`) is the one gate items, notes and now this file all
 * read through — trimmed, non-empty, deduplicated, in the user's own order.
 * Nothing here re-derives that rule; a rename builds the NEXT list by hand
 * (swap the old label for the new one) and hands it to `assertTags` before it
 * is written, exactly the way a hand-typed patch would be.
 *
 * ── THERE IS NO TAG RECORD ────────────────────────────────────────────────────
 * A tag is not a row anywhere — it is a string that happens to recur across
 * `SpoolItem.tags` and `SpoolNote.tags`. `spoolTags` below is a projection over
 * both, counted at read time, the same "derive on read" discipline
 * `spoolSubjects` already keeps for the project column.
 *
 * ── WHY A RENAME GOES STRAIGHT AT THE STORE, NOT THROUGH `updateItem`/
 *    `updateNote` (2026-08-18) ────────────────────────────────────────────────
 * It used to route through those two verbs, on the theory that a bespoke
 * rewrite path could drift from what a hand-typed tags patch would produce.
 * That was wrong in a way that made the verb unusable: `updateNote` refuses
 * ANY edit to a retired note ("a retired note is a record, not a draft —
 * write a new note instead of rewriting what was withdrawn"), because that
 * law protects the note's WORDS — `title`/`body`, what was said and then
 * withdrawn. A tag is not the note's words; it is index metadata that happens
 * to be stored in the same row, and relabelling the index does not rewrite
 * what was withdrawn. But `spoolTags` counts retired notes on purpose (the
 * same "retirement drains, never deletes" rule the shelf keeps everywhere
 * else) — so ANY tag whose only carrier is a retired note, which is the
 * ordinary end state of a note, could be listed but never renamed. And even
 * where SOME carriers were live, silently skipping the retired ones would
 * leave the old tag name still standing in the listing — a merge half done,
 * which is worse than refusing outright.
 *
 * So renaming a tag calls `rewriteItemTags`/`rewriteNoteTags` (`store.ts` /
 * `shelf.ts`) directly — the store's own records, tags array only, past every
 * content/state guard those two edit verbs carry. This is still not a
 * bespoke packet-rewrite path in the sense the old comment worried about:
 * `assertTags` is still the one gate the next tag list is built and checked
 * against before anything is written, exactly as a hand-typed patch would be.
 * What changed is WHICH function performs the write, because a tag rename is
 * not the kind of edit `updateItem`/`updateNote` exist to gate.
 *
 * ── A RENAME ONTO AN EXISTING TAG IS THE MERGE ────────────────────────────────
 * There is no separate "merge" verb. Renaming "urgente" to "cliente" when
 * "cliente" already exists simply produces rows that now carry "cliente" (and,
 * since `assertTags` deduplicates, never carry it twice) — merging IS what a
 * rename onto an occupied name means, exactly as it would if a human retyped
 * both tags to read the same word.
 */
import { assertTags, listItems, rewriteItemTags, type SpoolPaths } from "./store";
import { listNotes, rewriteNoteTags } from "./shelf";

export interface SpoolTagUsage {
  tag: string;
  /** How many items carry this tag right now. */
  items: number;
  /** How many shelf notes carry this tag right now — retired notes included,
   *  the same "retirement is not deletion" rule the shelf keeps everywhere
   *  else, so a count here can never disagree with what the shelf shows. */
  notes: number;
}

/**
 * EVERY TAG IN USE, alphabetised, with its two counts. A tag that exists on
 * disk but is carried by nothing (impossible today — there is no path to
 * write an orphan tag — but never assumed) simply would not appear: this is a
 * read over the rows, not a registry with its own emptiness to render.
 */
export function spoolTags(paths: SpoolPaths): SpoolTagUsage[] {
  const counts = new Map<string, { items: number; notes: number }>();
  const bump = (tag: string, field: "items" | "notes") => {
    const found = counts.get(tag) ?? { items: 0, notes: 0 };
    found[field] += 1;
    counts.set(tag, found);
  };
  for (const item of listItems(paths).items) {
    for (const tag of item.tags ?? []) bump(tag, "items");
  }
  for (const note of listNotes(paths)) {
    for (const tag of note.tags) bump(tag, "notes");
  }
  return [...counts.entries()]
    .map(([tag, c]) => ({ tag, items: c.items, notes: c.notes }))
    .sort((a, b) => a.tag.localeCompare(b.tag));
}

/**
 * Rename a tag everywhere it appears — on every item and every note, in one
 * call. Renaming onto a name already in use merges the two labels into one
 * (see the file header). Returns the landed name and how many rows changed;
 * a tag that was not carried by anything still succeeds, having renamed zero
 * rows, because "nothing had it" is not the same claim as "that name is
 * illegal".
 *
 * REFUSES LOUDLY, NEVER PARTIALLY: both names are validated with `assertTags`
 * — the same gate a hand-typed patch goes through — BEFORE any row is
 * touched, so a bad `to` cannot leave some items renamed and others not. An
 * identical `from`/`to` is refused too: it asks to change nothing, and a
 * "successful" no-op rename would be a write neither the human nor the store
 * ever actually wanted made.
 */
export function renameSpoolTag(paths: SpoolPaths, from: string, to: string): { tag: string; items: number; notes: number } {
  const [fromTag] = assertTags([from]);
  const [toTag] = assertTags([to]);
  if (fromTag === undefined || toTag === undefined) {
    throw new Error("A tag rename needs two names — the tag as it is now, and what to call it. Neither may be blank.");
  }
  if (fromTag === toTag) {
    throw new Error(`"${fromTag}" is already called that — renaming a tag onto itself changes nothing.`);
  }

  let items = 0;
  for (const item of listItems(paths).items) {
    if (!(item.tags ?? []).includes(fromTag)) continue;
    const nextTags = assertTags(item.tags!.map((tag) => (tag === fromTag ? toTag : tag)));
    rewriteItemTags(paths, item.id, nextTags);
    items += 1;
  }

  // RETIRED NOTES ARE CARRIERS TOO, and this loop does not skip them — see
  // the file header. `rewriteNoteTags` writes past `updateNote`'s
  // retired-note refusal on purpose: the words being protected there
  // (`title`/`body`) are untouched here.
  let notes = 0;
  for (const note of listNotes(paths)) {
    if (!note.tags.includes(fromTag)) continue;
    const nextTags = assertTags(note.tags.map((tag) => (tag === fromTag ? toTag : tag)));
    rewriteNoteTags(paths, note.id, nextTags);
    notes += 1;
  }

  return { tag: toTag, items, notes };
}
