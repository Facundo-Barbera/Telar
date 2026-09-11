/**
 * FINDING A SETTING WITHOUT KNOWING WHICH PANE IT IS ON.
 *
 * Settings is six panes in two groups, and General alone stacks six sections —
 * so "where do I turn off session naming" is answered by opening panes until
 * one of them has it. This module is the other half of the answer: an index of
 * every declared row, searched by title, hint, group and pane.
 *
 * TWO PIECES, AND THE ORDER MATTERS. `settingsRowId` is what a `Row` stamps on
 * itself as it renders (settings-shell.tsx); the index computes the SAME id from
 * the registry without rendering anything. That is what lets a result jump to a
 * row on a pane nobody has opened yet — the anchor is derived, not discovered,
 * so the index does not depend on the DOM having been built first.
 *
 * PURE ON PURPOSE. Nothing here touches `window`, React or the engine, so the
 * ranking can be pinned by a test rather than by opening the app and typing.
 */

/**
 * Text reduced to what a search should match on: lower case, accents folded,
 * apostrophes gone.
 *
 * ACCENTS FOLD BOTH WAYS — "Búsqueda" is found by "busqueda" and "busqueda" by
 * "Búsqueda" — because a person typing into a search field is not thinking
 * about their keyboard layout. NFD splits a letter from its combining mark and
 * the range strip removes the mark, which handles every accent in one rule
 * rather than a table of pairs.
 *
 * Apostrophes are DELETED rather than replaced, so "session's" folds to
 * "sessions" and is found by typing either. Both the typographic ’ and the
 * ASCII ' — the copy in this app uses the first and a keyboard produces the
 * second.
 */
export function foldForSearch(text: string): string {
  return text
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .replaceAll(/['\u2018\u2019]/g, "")
    .toLowerCase();
}

/** `foldForSearch`, then everything that is not a letter or digit becomes one
 *  hyphen. The shape an element id and a URL fragment can both carry. */
function slug(text: string): string {
  return foldForSearch(text)
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
}

/**
 * THE ANCHOR A ROW ANSWERS TO.
 *
 * Derived from where the row IS — pane, group, label — rather than assigned,
 * because an explicit id per row is a second thing to keep in step with the
 * label above it, and the one that silently rots is the id. The pane and group
 * are in the id because two panes may both hold a "Model" row and a fragment
 * has to name one of them.
 *
 * A row whose label is not a plain string (a component, a value spliced into a
 * sentence) has no slug to derive, so those rows pass an `id` themselves; this
 * function is what both paths agree on.
 */
export function settingsRowId(parts: { page?: string; group?: string; label: string }): string {
  const trail = [parts.page, parts.group, parts.label].map((part) => (part ? slug(part) : "")).filter(Boolean);
  return `settings-row-${trail.join("-")}`;
}
