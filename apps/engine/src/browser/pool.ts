/**
 * A small LRU over heavyweight per-scope resources — in practice, one Chromium
 * per session.
 *
 * Ported from `apps/web_old/lib/server/browser-runtime.ts` WITH THE MISSING HALF
 * ADDED. The legacy pool had `acquire`, `peek` and `size` and no way to remove
 * anything: the only path out was capacity pressure evicting the oldest idle
 * entry. That is survivable in a page-lifetime web server and is a leak in a
 * long-lived daemon — a session that ends leaves its browser resident until six
 * more sessions have started, which on a machine running two sessions a day
 * means never. `release` and `clear` are the fix, and they are why an engine
 * can own a browser at all.
 */

export type ScopedRuntimeResource = {
  isBusy(): boolean;
  /**
   * Tear the resource down. MUST NOT REJECT — the pool calls this from paths
   * that cannot report a failure (LRU eviction inside a synchronous `acquire`),
   * and an unhandled rejection there takes down the daemon rather than one
   * browser. Swallow and record instead.
   */
  dispose(reason: string): void | Promise<void>;
};

/**
 * Busy resources are never evicted by capacity: a detached agent keeps its
 * browser even while the human is looking at another session. If every retained
 * resource is busy the pool may temporarily exceed its limit, and a later
 * acquisition reclaims the oldest idle entry.
 */
export class ScopedRuntimePool<T extends ScopedRuntimeResource> {
  private entries = new Map<string, { resource: T; usedAt: number }>();
  /** A monotonic counter, not a clock. `Date.now()` has millisecond resolution
   *  and two acquisitions in the same millisecond would tie, making eviction
   *  order depend on Map insertion order rather than on use. */
  private clock = 0;

  constructor(private readonly limit: number) {}

  acquire(scopeKey: string, create: () => T): T {
    const existing = this.entries.get(scopeKey);
    if (existing) {
      existing.usedAt = ++this.clock;
      return existing.resource;
    }
    if (this.entries.size >= this.limit) {
      const candidate = [...this.entries.entries()]
        .filter(([, entry]) => !entry.resource.isBusy())
        .sort(([, a], [, b]) => a.usedAt - b.usedAt)[0];
      if (candidate) {
        const [key, entry] = candidate;
        this.entries.delete(key);
        // Not awaited: `acquire` is synchronous so that the caller can take its
        // lease on a scope before any await point (see `index.ts`). `dispose`
        // is contractually non-rejecting, so nothing is dropped here.
        void entry.resource.dispose("The inactive browser session was reclaimed.");
      }
    }
    const resource = create();
    this.entries.set(scopeKey, { resource, usedAt: ++this.clock });
    return resource;
  }

  peek(scopeKey: string): T | null {
    return this.entries.get(scopeKey)?.resource ?? null;
  }

  /**
   * Drop one scope and tear its resource down. Returns false when there was
   * nothing to release, so a caller can tell "freed a browser" from "there was
   * never one" without peeking first.
   *
   * UNCONDITIONAL, UNLIKE CAPACITY EVICTION — a busy resource is released too.
   * The caller is asserting that the scope is over (its session was archived,
   * its runtime exited), and work still in flight for a scope that no longer
   * exists is not work worth protecting, it is the leak itself. In-flight calls
   * see the dispose reason as their rejection.
   */
  async release(scopeKey: string, reason = "The browser session was closed."): Promise<boolean> {
    const entry = this.entries.get(scopeKey);
    if (!entry) return false;
    this.entries.delete(scopeKey);
    await entry.resource.dispose(reason);
    return true;
  }

  /** Release everything, concurrently. The pool is reusable afterwards. */
  async clear(reason = "The browser runtime was shut down."): Promise<void> {
    const resources = [...this.entries.values()].map((entry) => entry.resource);
    // Cleared BEFORE awaiting: a dispose that turns around and calls back into
    // the pool (a child-exit handler racing shutdown) must not find the entry
    // it is tearing down still listed.
    this.entries.clear();
    await Promise.all(resources.map((resource) => resource.dispose(reason)));
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }

  get size(): number {
    return this.entries.size;
  }
}
