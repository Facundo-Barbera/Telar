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
 * PURE ON PURPOSE. Nothing here touches `window`, the DOM or the engine — React
 * appears only as the type of a glyph carried through untouched — so the
 * ranking can be pinned by a test rather than by opening the app and typing.
 */
import type { ComponentType } from "react";

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

/** A Lucide-shaped glyph. Carried through the index untouched — nothing here
 *  renders it; the result list does. */
export type SettingsSearchIcon = ComponentType<{ className?: string }>;

/**
 * WHAT THE REGISTRY DECLARES, row by row.
 *
 * `hint` is the row's own sentence, and it is here because "stop asking me
 * before I delete" is how somebody looks for a row titled "Confirm deletions" —
 * people search for what a setting DOES more often than for what it is called.
 * `keywords` is for the word that is in neither: the old name of a thing, the
 * word another app uses for it.
 */
export type SettingsRowSpec = {
  /** Only for rows whose label is not a plain string; otherwise derived. */
  id?: string;
  title: string;
  hint?: string;
  keywords?: readonly string[];
  icon?: SettingsSearchIcon;
};

export type SettingsGroupSpec = {
  /** Matches the rendered `SettingsGroup` title, and is part of every id below it. */
  title?: string;
  rows: readonly SettingsRowSpec[];
};

export type SettingsPageSpec = {
  /** The pane id the shell selects — `general`, `appearance`, … */
  id: string;
  label: string;
  icon?: SettingsSearchIcon;
  groups: readonly SettingsGroupSpec[];
};

/** One row, flattened, with the page it lives on and the text a query is
 *  matched against already folded. */
export type SettingsSearchEntry = {
  id: string;
  title: string;
  hint?: string;
  group?: string;
  pageId: string;
  pageLabel: string;
  icon?: SettingsSearchIcon;
  /** Folded once at index time so a keystroke does not re-fold the whole corpus. */
  folded: { title: string; hint: string; place: string };
};

export type SettingsSearchIndex = { entries: readonly SettingsSearchEntry[] };

/**
 * THE INDEX IS BUILT FROM A DECLARATION, NOT FROM THE SCREEN.
 *
 * Walking the rendered DOM would only ever know about panes somebody has
 * already opened — which is precisely the case where search is not needed. The
 * registry states every row up front, so the first thing a person does after
 * pressing `/` can be to find a setting on a pane they have never visited.
 *
 * The cost is that the registry has to be kept in step with the sections, and
 * the test beside it is what does that: every declared title must still appear
 * in a settings source file.
 */
export function indexSettings(pages: readonly SettingsPageSpec[]): SettingsSearchIndex {
  const entries: SettingsSearchEntry[] = [];
  for (const page of pages) {
    for (const group of page.groups) {
      for (const row of group.rows) {
        const id = row.id ?? settingsRowId({ page: page.id, ...(group.title ? { group: group.title } : {}), label: row.title });
        // A row's own glyph when it has one, the pane's otherwise: a result list
        // of six identical pane glyphs distinguishes nothing, and a row that
        // already wears an icon in the pane should wear the same one here.
        const icon = row.icon ?? page.icon;
        entries.push({
          id,
          title: row.title,
          ...(row.hint ? { hint: row.hint } : {}),
          ...(group.title ? { group: group.title } : {}),
          pageId: page.id,
          pageLabel: page.label,
          ...(icon ? { icon } : {}),
          folded: {
            title: foldForSearch(row.title),
            // Keywords ride with the hint: both answer "does this row do the
            // thing I am describing", and neither is what the result shows.
            hint: foldForSearch([row.hint, ...(row.keywords ?? [])].filter(Boolean).join(" ")),
            place: foldForSearch([group.title, page.label].filter(Boolean).join(" ")),
          },
        });
      }
    }
  }
  return { entries };
}

/**
 * HOW CLOSE A MATCH IS, smaller is better; `undefined` is no match at all.
 *
 * The order encodes what a person means when they stop typing: the first
 * letters of a title are the strongest claim, a whole word inside it the next,
 * and a row found only by its description or by the pane it sits on is real but
 * belongs below the rows that say the word themselves.
 *
 * The last tier is the one that saves a half-remembered title: "name session"
 * matching "Name sessions" — every term present somewhere, in any order.
 */
function rank(entry: SettingsSearchEntry, query: string, terms: readonly string[]): number | undefined {
  const { title, hint, place } = entry.folded;
  if (title.startsWith(query)) return 0;
  if (new RegExp(`\\b${query.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(title)) return 1;
  if (title.includes(query)) return 2;
  if (hint.includes(query)) return 3;
  if (place.includes(query)) return 4;
  const all = `${title} ${hint} ${place}`;
  if (terms.length > 1 && terms.every((term) => all.includes(term))) return 5;
  return undefined;
}

/**
 * Rows matching `query`, best first.
 *
 * STABLE BELOW THE RANK: ties keep registry order, which is the order the panes
 * and groups are written in — so a result list does not reshuffle under the
 * cursor as a query grows by one character that changed nothing.
 */
export function searchSettings(
  index: SettingsSearchIndex,
  query: string,
  options?: { limit?: number },
): SettingsSearchEntry[] {
  const folded = foldForSearch(query).trim();
  if (!folded) return [];
  const terms = folded.split(/\s+/).filter(Boolean);
  const scored: { entry: SettingsSearchEntry; rank: number; order: number }[] = [];
  index.entries.forEach((entry, order) => {
    const score = rank(entry, folded, terms);
    if (score !== undefined) scored.push({ entry, rank: score, order });
  });
  scored.sort((a, b) => a.rank - b.rank || a.order - b.order);
  const limit = options?.limit ?? scored.length;
  return scored.slice(0, limit).map((hit) => hit.entry);
}
