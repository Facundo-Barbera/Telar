/**
 * THE TRIAGE CACHE — the thing that makes reading a backlog affordable.
 *
 * The bottleneck is not dispatch, it is triage. In the backlog that motivated
 * this system, 4 of 37 open issues were dispatchable and the other 33 were
 * blocked on a human decision, on live credentials, or on decomposition — with
 * NOTHING in the repo distinguishing them. There is no label for any of it, so
 * the classification has to be re-derived from prose, and a naive orchestrator
 * that skips that step picks the credentials one, burns a loom, and produces a
 * PR that cannot be correct.
 *
 * Re-deriving it every tick would be unaffordable, so it is cached — and the
 * cache is invalidated by the item's OWN revision token, not by a clock. That
 * is what turns "read the whole comment thread and work out what is actually
 * being asked" into a cost paid ONCE PER ITEM PER CHANGE rather than once every
 * five minutes.
 *
 * ── `updatedAt` IS OPAQUE, AND THAT IS DELIBERATE ────────────────────────────
 * It is whatever the project's own `list` command reported: an ISO date from
 * `gh`, an mtime, a git sha, a hash of a line in `inbox.md`. Nothing here parses
 * it or compares it for ORDER — only for equality. The moment this file tries
 * to read a date out of it, projects whose token is not a date stop working,
 * and the four-command contract has quietly grown a fifth requirement.
 */
import type { TriageEntry } from "@telar/engine-client";

/** Keyed by item ref. Derived, rebuildable, machine-local — never on the wire
 *  (the seam returns `{entries: TriageEntry[]}`; this is the working shape). */
export type TriageCache = Record<string, TriageEntry>;

/** The shape the `list` command's output is reduced to before it gets here. */
export type ListedItem = { item: string; updatedAt: string };

/**
 * Which listed items need re-reading: the ones with no cached classification,
 * and the ones whose revision token no longer matches what we classified.
 *
 * Order follows `list`, so the project's own ordering (priority, milestone,
 * recency — whatever it chose) survives into the tick's reading order and the
 * expensive work happens on the items the project put first. Duplicates in the
 * list collapse, because reading the same item twice in one tick is pure waste.
 */
export function staleItems(cache: TriageCache, listed: ListedItem[]): string[] {
  const stale: string[] = [];
  const seen = new Set<string>();
  for (const { item, updatedAt } of listed) {
    if (seen.has(item)) continue;
    seen.add(item);
    const cached = cache[item];
    if (!cached || cached.updatedAt !== updatedAt) stale.push(item);
  }
  return stale;
}

/**
 * Drop entries for items the project no longer lists.
 *
 * An item that fell out of `list` was closed, or relabelled out of scope, or
 * the query changed — in every case the cached classification is now a claim
 * about something nobody is looking at, and keeping it would grow the tick's
 * input forever. Returns a NEW cache; the caller persists it.
 *
 * NOTE THE ASYMMETRY WITH `staleItems`: absence from `list` prunes, it does not
 * mark stale. Nothing is re-read on the way out.
 */
export function pruneCache(cache: TriageCache, listed: Array<{ item: string }>): TriageCache {
  const live = new Set(listed.map((l) => l.item));
  const next: TriageCache = {};
  for (const [item, entry] of Object.entries(cache)) if (live.has(item)) next[item] = entry;
  return next;
}
