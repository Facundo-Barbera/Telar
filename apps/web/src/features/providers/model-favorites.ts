const KEY = "telar:favorite-models:v2";

export function readFavorites(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): Set<string> {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : []);
  } catch {
    return new Set();
  }
}

export function orderByFavorite<T extends { id: string }>(options: readonly T[], favorites: ReadonlySet<string>): T[] {
  return [...options.filter((option) => favorites.has(option.id)), ...options.filter((option) => !favorites.has(option.id))];
}

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
