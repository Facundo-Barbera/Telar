"use client";

type CacheEntry = { at: number; value: unknown };

const values = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<unknown>>();

/** Deduplicates identical client GETs across component remounts. This is only a
 * short-lived navigation cache; mutations still opt into a forced revalidate. */
export async function cachedJson<T>(
  url: string,
  options: { maxAgeMs?: number; force?: boolean } = {},
): Promise<T> {
  const maxAgeMs = options.maxAgeMs ?? 30_000;
  const cached = values.get(url);
  if (!options.force && cached && Date.now() - cached.at < maxAgeMs) {
    return cached.value as T;
  }
  const existing = pending.get(url);
  if (existing) return existing as Promise<T>;

  const request = fetch(url)
    .then(async (response) => {
      if (!response.ok) throw new Error(`GET ${url} failed (${response.status})`);
      const value = (await response.json()) as T;
      values.set(url, { at: Date.now(), value });
      return value;
    })
    .finally(() => pending.delete(url));
  pending.set(url, request);
  return request;
}

export function invalidateCachedJson(url: string): void {
  values.delete(url);
}
