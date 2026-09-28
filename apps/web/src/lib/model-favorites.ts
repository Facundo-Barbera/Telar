/**
 * STARRED MODELS — the ORDERING RULES, plus a read-only door to the old store.
 *
 * A menu of six is a list; a menu of sixteen is a search problem, and the
 * catalogue only grows. Favourites are the reference cockpit's answer and they
 * are the right one here for a reason particular to this app: a person working
 * on one repository uses two models for weeks, and scrolling past the other
 * fourteen every time is a tax on the thing they do most.
 *
 * THEY USED TO LIVE IN `localStorage` AND NOW LIVE ON THE ENGINE, keyed by row
 * rather than by family (`ModelOverlay.favorites`). The old argument was sound
 * while it held: a star changed how a menu sorted and nothing about what ran, so
 * engine state would have made a display choice durable and replicated for no
 * gain. What ended it is the Models tab in Settings, where a star now sits in
 * the same row as a hide and a hand-added id — both engine facts by necessity.
 * Two stores behind one row is how "I unstarred it and it came back" happens.
 *
 * SO THE WRITER IS GONE AND THE READER STAYS. `readFavorites` exists for exactly
 * one caller — the one-time-per-login import in lib/model-catalogue-cache.ts —
 * so nobody loses the stars they already had. Nothing writes this key any more,
 * and nothing should: a second writer would recreate the split this import
 * exists to close.
 */
const KEY = "telar:favorite-models:v2";

/**
 * Favourites are keyed by the FAMILY id — the resolved model id with the context
 * window and the dated build stripped off (lib/model-families.ts) — so one star
 * means the same model across every project and session in this browser, and
 * keeps meaning it when the provider re-points an alias or you switch windows.
 *
 * NO PROVIDER PREFIX, unlike the donor's `claude:sonnet`: a resolved id is
 * already provider-unique, and every star is looked up against a catalogue that
 * came from one provider, so a prefix would be a second copy of a fact the
 * caller already has.
 *
 * `:v2` BECAUSE THE KEYS CHANGED MEANING. They used to be catalogue ids —
 * `sonnet`, `opus[1m]` — which no longer match anything the picker lists. A
 * version bump loses the stars once, which is a gesture; silently matching
 * nothing would look like a broken star.
 */
export function readFavorites(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): Set<string> {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    // A shape written by another build, or by a person in devtools. A bad list
    // costs the sorting, never the menu.
    return new Set(Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : []);
  } catch {
    return new Set();
  }
}

/**
 * Favourites first, then everything else, each half in catalogue order.
 *
 * STABLE WITHIN EACH HALF — not sorted by name, not by recency. A menu whose
 * rows move when you are not looking is a menu you have to read every time, and
 * the catalogue's own order already puts the models people reach for at the top.
 */
export function orderByFavorite<T extends { id: string }>(options: readonly T[], favorites: ReadonlySet<string>): T[] {
  return [...options.filter((option) => favorites.has(option.id)), ...options.filter((option) => !favorites.has(option.id))];
}

/**
 * A STARRED MODEL IS NEVER FOLDED AWAY, whatever generation it belongs to.
 *
 * The picker hides older generations behind a "Legacy models" row, and by the
 * version rule Haiku 4.5 is one — it is a whole number behind the default. That
 * is the right default and the wrong answer for the person who starred it: a
 * star says KEEP THIS AT THE TOP, and a star that leaves the model one click
 * further away than before it was pressed is a control working against itself.
 */
export function keepStarredVisible<T extends { id: string }>(
  split: { current: T[]; legacy: T[] },
  favorites: ReadonlySet<string>,
): { current: T[]; legacy: T[] } {
  if (!split.legacy.some((option) => favorites.has(option.id))) return split;
  return {
    current: [...split.current, ...split.legacy.filter((option) => favorites.has(option.id))],
    legacy: split.legacy.filter((option) => !favorites.has(option.id)),
  };
}

function safeStorage(): Pick<Storage, "getItem" | "setItem"> | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}
