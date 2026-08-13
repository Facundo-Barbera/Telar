/**
 * STARRED MODELS.
 *
 * A menu of six is a list; a menu of sixteen is a search problem, and the
 * catalogue only grows. Favourites are the reference cockpit's answer and they
 * are the right one here for a reason particular to this app: a person working
 * on one repository uses two models for weeks, and scrolling past the other
 * fourteen every time is a tax on the thing they do most.
 *
 * PER BROWSER, NOT PER SESSION AND NOT ON THE ENGINE. This is a preference about
 * how a menu is sorted — it changes nothing about what runs — so putting it in
 * engine state would make a display choice durable, replicated and versioned for
 * no gain. `localStorage` is the honest home, and losing it costs one gesture.
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

export function writeFavorites(next: ReadonlySet<string>, storage: Pick<Storage, "setItem"> | undefined = safeStorage()): void {
  try {
    storage?.setItem(KEY, JSON.stringify([...next]));
  } catch {
    // Private browsing, or storage disabled. The in-memory set still works for
    // this page, which is the whole of what the menu needs.
  }
}

export function toggleFavorite(current: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(current);
  if (!next.delete(id)) next.add(id);
  return next;
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
