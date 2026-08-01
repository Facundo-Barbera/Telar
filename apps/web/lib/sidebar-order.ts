// What the sidebar's lists CONTAIN and in what ORDER — the pinned projects, the
// recents beneath them, and the account wheels in the footer. Pure — no React,
// no localStorage — because ordering is the part of that file which is easy to
// get quietly wrong and impossible to eyeball: "did pinning this move anything
// else", "why is that row sixth", "where does a dragged wheel actually land"
// are questions only a test answers honestly. The storage stays in the
// component, which owns the hydration dance; everything here takes arrays and
// returns arrays.
//
// PINS AND WHEELS REMEMBER DIFFERENTLY, and the difference is the one thing to
// carry away from this file. A wheel order is a complete arrangement of a known
// set, so it is reconciled against the live accounts on every read — vanished
// names disappear, newcomers land at the end. A pin list is a handful of
// independent bookmarks, so it is never reconciled: a pin whose project is no
// longer registered simply does not render, and the row reappears in its old
// position if the project comes back. Applying either rule to the other list
// would look like a cleanup and behave like data loss.
//
// EVERY RULE HERE IS THE ONE THE SIDEBAR ALREADY FOLLOWED, including the two
// that are arguable (a drop on the last row cannot reach the last position; a
// hand-edited duplicate renders twice). Each of those says so where it lives.
// They are transcribed rather than corrected on purpose — this module exists to
// make current behaviour testable, and a sidebar that silently reorders itself
// the day it grew tests is the worst trade available.

// The localStorage keys these two arrangements live under. They travel with the
// rules that read them for the same reason sidebar-width.ts keeps its prefix
// beside its parser: the spelling of a key is part of what the stored value
// means, and a rename that misses one half is a silent reset for every user.
//
// NOTE, not a bug to fix here: app/projects/page.tsx pins under a different key
// ("telar:pinnedProjects") with a different shape (an unordered Set), so the two
// surfaces do not share pins. Unifying them changes what both pages show, which
// makes it somebody else's call.
export const PINNED_KEY = "telar:pinned-projects";
export const WHEEL_ORDER_KEY = "telar:account-wheel-order";

// How many non-pinned projects the Recent group surfaces. The cap is applied
// last — after the pin exclusion and after the sort — so pinning a project
// promotes something into view rather than merely relabelling a row.
export const RECENTS_LIMIT = 6;

// Parse a raw localStorage value into a string[], dropping anything that isn't
// one (wrong shape, e.g. `false`/`{}` from a stale or hand-edited key) instead
// of blindly casting it — callers must always get a real array.
//
// A MIXED ARRAY IS REJECTED WHOLE rather than filtered down to its strings.
// Half-trusting a value nobody wrote deliberately is how a corrupt key survives
// long enough to look like a feature; an empty list is a state the sidebar
// already renders correctly.
export function parseStoredList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) && v.every((x) => typeof x === "string") ? v : [];
  } catch {
    return [];
  }
}

// ── pins ────────────────────────────────────────────────────────────────────

// Pinning APPENDS. Pinned order is pin order — the oldest pin sits at the top —
// because the list is the user's own arrangement, and re-sorting it by name or
// by recency would move rows they placed on purpose. Nothing else sorts it, and
// pinned rows are not drag-reorderable.
//
// Unpinning filters instead of splicing, so a name that appears twice (only
// reachable by hand-editing the key) is purged entirely rather than leaving a
// ghost that needs a second click.
export function togglePinned(pinned: readonly string[], name: string): string[] {
  return pinned.includes(name) ? pinned.filter((n) => n !== name) : [...pinned, name];
}

// The pinned rows to render: the stored order, resolved against the projects
// that currently exist. A name that resolves to nothing is dropped here and
// LEFT IN THE STORE — see the note at the top of the file for why that is the
// point rather than an oversight.
//
// Duplicates in `pinned` resolve to the same project twice, which renders two
// sibling rows under one React key. Preserved as-is: the only way to get there
// is to edit the key by hand, and de-duplicating on read would quietly rewrite
// what the user typed on the next unpin.
export function pinnedProjects<T extends { name: string }>(
  pinned: readonly string[],
  projects: readonly T[],
): T[] {
  const byName = new Map(projects.map((p) => [p.name, p]));
  return pinned.map((n) => byName.get(n)).filter((p): p is T => p != null);
}

// ── recents ─────────────────────────────────────────────────────────────────

// What the recents order reads. Deliberately structural rather than importing
// the sidebar's row type: this module is about ORDER, and narrowing the input to
// the three fields order actually touches keeps a test case three fields long
// instead of a whole project record with looms and chats hanging off it.
export type OrderableProject = {
  name: string;
  // The freshest touch, in ms. What counts as a touch is the caller's business.
  recency: number;
  // A loom is in flight for this project.
  active: boolean;
};

// ACTIVE FIRST IS A PARTITION, NOT A WEIGHT. A project with something weaving
// outranks every idle project no matter how stale it is, because an in-flight
// loom is the only thing in this list that might need the reader now; recency
// then orders each group internally. That is why the active key is applied
// first and returns outright, rather than contributing to a score where a very
// recent idle project could out-total it.
export function compareRecents(a: OrderableProject, b: OrderableProject): number {
  if (a.active !== b.active) return a.active ? -1 : 1;
  return b.recency - a.recency;
}

// Everything not pinned, active-first then by recency, capped.
//
// EXCLUSION IS BY RESOLVED PIN, not by stored pin name — `pinned` is the rows
// that actually rendered in the Pinned group. Same outcome today (a name with no
// project cannot match anything in `projects` either), but it keeps the two
// groups from ever disagreeing about which rows they own if `projects` widens.
//
// THE TIE-BREAK IS THE CALLER'S ORDER. Two projects with equal `recency` — two
// that have never been touched and share a registration millisecond, two bumped
// by the same loom — hold the position they arrived in, because `filter` builds
// a fresh array and `sort` is stable. So the array handed in is load-bearing:
// pre-sorting it, or rebuilding it from a Map's iteration, reorders rows that
// nothing in this comparator asked to move. Sorting the copy also leaves the
// caller's array untouched, which matters when it is React state.
export function recentProjects<T extends OrderableProject>(
  projects: readonly T[],
  pinned: readonly { name: string }[],
  limit: number = RECENTS_LIMIT,
): T[] {
  const excluded = new Set(pinned.map((p) => p.name));
  return projects
    .filter((p) => !excluded.has(p.name))
    .sort(compareRecents)
    .slice(0, limit);
}

// The one row that gets the highlight bar: the first ACTIVE project in the
// already-ordered recents. Only ever one, and only ever in Recent — a pinned
// project that is weaving gets no bar, because the Pinned group is a place the
// user chose to look and does not need to be steered toward.
//
// Written as a find over the ordered list rather than `recents[0]` so it stays
// truthful if the partition above ever stops leading.
export function highlightedProject(recents: readonly OrderableProject[]): string | undefined {
  return recents.find((p) => p.active)?.name;
}

// ── wheel order ─────────────────────────────────────────────────────────────

// Keep a stored order aligned with the live set: drop names that vanished,
// append newcomers in their canonical order at the end.
//
// NEWCOMERS GO LAST, never alphabetically among the remembered ones, because
// the remembered part is an arrangement — inserting into the middle of it moves
// wheels the user placed in order to make room for one they have never seen.
//
// A dropped name is only dropped from the RENDER. Nothing writes this result
// back until the next drag, so switching an account off and on again restores
// its remembered position; switching it off, dragging, then on again appends it.
// That asymmetry is the price of never writing to storage on a read.
//
// Duplicates in `stored` survive `kept` (a filter, not a dedupe) and render two
// wheels for one account. Only reachable by hand-editing the key, and the first
// drag collapses it — see moveByName.
export function reconcileOrder(stored: readonly string[], actual: readonly string[]): string[] {
  const kept = stored.filter((n) => actual.includes(n));
  const added = actual.filter((n) => !kept.includes(n));
  return [...kept, ...added];
}

// One drag: `from` lands immediately BEFORE `to`, whichever direction the
// pointer travelled.
//
// THAT RULE HAS A QUIRK WORTH KNOWING BEFORE YOU "FIX" IT: dropping onto the
// last wheel puts you second-to-last, so the final position is not reachable by
// dropping on the row that occupies it. Preserved deliberately — direction-aware
// insertion is a different interaction (it needs a drop indicator that can sit
// after a row, which DropBar cannot), and changing where a dragged wheel lands
// is a visible change, not a refactor.
//
// The two guards are what keep index arithmetic out of this: a self-drop returns
// the very same array, and a target that isn't in the order returns it
// unchanged, so there is no computed index that can land past either end.
// `filter` also removes every occurrence of `from`, which is how a hand-edited
// duplicate collapses to one on its first drag.
export function moveByName(order: string[], from: string, to: string): string[] {
  if (from === to) return order;
  const next = order.filter((n) => n !== from);
  const at = next.indexOf(to);
  if (at === -1) return order;
  next.splice(at, 0, from);
  return next;
}
