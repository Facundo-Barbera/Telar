export type ScopedRuntimeResource = {
  isBusy(): boolean;
  dispose(reason: string): void | Promise<void>;
};

export class ScopedRuntimePool<T extends ScopedRuntimeResource> {
  private entries = new Map<string, { resource: T; usedAt: number }>();
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

  async release(scopeKey: string, reason = "The browser session was closed."): Promise<boolean> {
    const entry = this.entries.get(scopeKey);
    if (!entry) return false;
    this.entries.delete(scopeKey);
    await entry.resource.dispose(reason);
    return true;
  }

  async clear(reason = "The browser runtime was shut down."): Promise<void> {
    const resources = [...this.entries.values()].map((entry) => entry.resource);
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
