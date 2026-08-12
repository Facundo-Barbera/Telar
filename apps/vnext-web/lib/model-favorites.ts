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
const KEY = "telar:favorite-models:v1";

/** Favourites are keyed by the provider's own model id, so the same star means
 *  the same model across every project and session in this browser. */
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

function safeStorage(): Pick<Storage, "getItem" | "setItem"> | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}
