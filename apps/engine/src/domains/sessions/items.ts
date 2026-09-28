import path from "node:path";
import { Item } from "@telar/engine-client";
import type { EngineEvent } from "@telar/engine-client";
import { EngineStateError, type Kernel } from "../../platform/kernel";
import type { EngineStatePaths } from "../../state-paths";
import { sessionDir } from "./metadata";

const ITEMS_CACHE_LIMIT = 8;
const OPEN_PREFIX_LIMIT = 64;

function itemsFile(paths: EngineStatePaths, sessionId: string): string {
  return path.join(sessionDir(paths, sessionId), "items.json");
}

function itemsIndexFile(paths: EngineStatePaths, sessionId: string): string {
  return path.join(sessionDir(paths, sessionId), "items.index.json");
}

/**
 * Each session's item projection: rows once migrated, `items.json` before that.
 * The cache is bounded and shared: callers replace items, never edit one in place,
 * and nothing removes an item (an upsert can't notice a missing row).
 */
export class SessionItems {
  private readonly cache = new Map<string, Map<string, Item>>();
  private migrationSuppressed = false;

  constructor(private readonly kernel: Kernel) {
    kernel.onRollback(() => this.cache.clear());
    kernel.onSessionDeleted((id) => this.cache.delete(id));
  }

  clear(): void {
    this.cache.clear();
  }

  /** Runs `fn` without migrating the sessions it reads; a whole-store pass must not migrate what it walks past. */
  withoutMigration<T>(fn: () => T): T {
    this.migrationSuppressed = true;
    try {
      return fn();
    } finally {
      this.migrationSuppressed = false;
    }
  }

  /** A copy the caller may edit and hand back to `write`. */
  read(sessionId: string): Map<string, Item> {
    return new Map(this.byId(sessionId));
  }

  values(sessionId: string): Item[] {
    return [...this.byId(sessionId).values()];
  }

  has(sessionId: string, itemId: string): boolean {
    const cached = this.cache.get(sessionId);
    if (cached) return cached.has(itemId);
    if (this.onRows(sessionId)) return this.kernel.executionStore.hasItemRow(sessionId, itemId);
    return this.byId(sessionId).has(itemId);
  }

  /** The items filed under `runs`: from the cache, the rows, or the indexed span, in that order. */
  forRuns(sessionId: string, runs: Set<string>): Item[] {
    if (this.cache.has(sessionId)) return this.values(sessionId).filter((item) => runs.has(item.runId));
    if (this.onRows(sessionId)) return this.rowsOf(sessionId, [...runs]);
    const file = itemsFile(this.kernel.paths, sessionId);
    const index = this.kernel.documentIndex(file, itemsIndexFile(this.kernel.paths, sessionId));
    if (!index) return this.values(sessionId).filter((item) => runs.has(item.runId));
    const parsed = Item.array().safeParse(this.kernel.readIndexedRows(file, index.rows.filter((row) => runs.has(row.key))));
    if (!parsed.success) throw new EngineStateError("invalid_request", "invalid item projection");
    return parsed.data.filter((item) => runs.has(item.runId));
  }

  /** One run's items only when they're cheap to get; a cold JSON-backed session answers empty. */
  peekRun(sessionId: string, runId: string): Item[] {
    const cached = this.cache.get(sessionId);
    if (cached) return [...cached.values()].filter((item) => item.runId === runId);
    return this.onRows(sessionId) ? this.rowsOf(sessionId, [runId]) : [];
  }

  /** The single writer. `touched` names the items that moved; absent means all of them. */
  write(sessionId: string, items: Map<string, Item>, touched?: ReadonlySet<string>): void {
    if (!this.onRows(sessionId)) this.migrate(sessionId, items);
    else {
      const moved = touched ? [...touched].map((id) => items.get(id)).filter((item): item is Item => item !== undefined) : [...items.values()];
      this.kernel.executionStore.upsertItems(sessionId, moved.map((item) => ({ id: item.id, runId: item.runId, value: JSON.stringify(item) })));
    }
    this.remember(sessionId, new Map(items));
  }

  /** Settles the in-progress items of runs that ended, as `failed`. */
  closeOpen(sessionId: string, runIds: ReadonlySet<string>, at: number): number {
    if (runIds.size === 0) return 0;
    const items = this.read(sessionId);
    const closed = new Set<string>();
    for (const item of items.values()) {
      if (!runIds.has(item.runId) || item.status !== "inProgress") continue;
      const settled: Item = { ...item, status: "failed", completedAt: at };
      items.set(item.id, settled);
      this.kernel.appendEvent(sessionId, { type: "item.completed", item: settled }, item.runId);
      closed.add(item.id);
    }
    if (closed.size > 0) this.write(sessionId, items, closed);
    return closed.size;
  }

  private remember(sessionId: string, items: Map<string, Item>): void {
    if (!this.cache.has(sessionId) && this.cache.size >= ITEMS_CACHE_LIMIT) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(sessionId, items);
  }

  // The marker decides, not the document: a migrated session and one that never opened an item both lack items.json.
  private onRows(sessionId: string): boolean {
    return this.kernel.executionStore.itemsAreRows(sessionId);
  }

  private migrate(sessionId: string, items: Map<string, Item>): void {
    this.kernel.executionStore.migrateItemsToRows(
      sessionId,
      [...items.values()].map((item) => ({ id: item.id, runId: item.runId, value: JSON.stringify(item) })),
      [itemsFile(this.kernel.paths, sessionId), itemsIndexFile(this.kernel.paths, sessionId)],
    );
  }

  private byId(sessionId: string): Map<string, Item> {
    const cached = this.cache.get(sessionId);
    if (cached) return cached;
    if (this.onRows(sessionId)) {
      const items = this.parseRows(this.kernel.executionStore.itemRows(sessionId));
      this.remember(sessionId, items);
      return items;
    }
    const file = itemsFile(this.kernel.paths, sessionId);
    const stored = this.kernel.readDocument(file);
    if (stored === undefined) return new Map();
    this.kernel.accountWholeRead(file);
    this.kernel.readAccounting.itemParses += 1;
    const parsed = Item.array().safeParse((stored as { items?: unknown }).items);
    if (!parsed.success) throw new EngineStateError("invalid_request", "invalid item projection");
    const items = new Map(parsed.data.map((item) => [item.id, item]));
    // The first read of a JSON session is its migration, so an archived one stops costing the blob.
    if (!this.migrationSuppressed) this.migrate(sessionId, items);
    this.remember(sessionId, items);
    return items;
  }

  private parseRows(rows: string[]): Map<string, Item> {
    this.kernel.readAccounting.itemParses += 1;
    return new Map(this.parseCounted(rows).map((item) => [item.id, item]));
  }

  // A window: counted in bytes, not in `itemParses`, so a whole read can't hide as one.
  private rowsOf(sessionId: string, runs: readonly string[]): Item[] {
    const rows = this.kernel.executionStore.itemRowsForRuns(sessionId, runs);
    return rows.length === 0 ? [] : this.parseCounted(rows);
  }

  private parseCounted(rows: string[]): Item[] {
    let bytes = 0;
    const seen: unknown[] = [];
    for (const row of rows) { bytes += Buffer.byteLength(row, "utf8"); seen.push(JSON.parse(row)); }
    this.kernel.readAccounting.documentBytes += bytes;
    this.kernel.readAccounting.documentReads += 1;
    const parsed = Item.array().safeParse(seen);
    if (!parsed.success) throw new EngineStateError("invalid_request", "invalid item projection");
    return parsed.data;
  }
}

type Prefix = { text: string; through: number; sealed: boolean };

/**
 * Text streamed into still-open items, keyed by session and item, bounded by
 * least-recent write. Only a sealed entry (grown from the item's first delta) is
 * trusted; anything else is rebuilt from the journal.
 */
export class OpenPrefixes {
  private readonly prefixes = new Map<string, Prefix>();

  constructor(
    kernel: Kernel,
    private readonly readEvents: (sessionId: string) => EngineEvent[],
  ) {
    kernel.onRollback(() => this.prefixes.clear());
  }

  clear(): void {
    this.prefixes.clear();
  }

  get size(): number {
    return this.prefixes.size;
  }

  /** The streamed text complete through `streamedThrough`, which never exceeds `through`. */
  get(sessionId: string, itemId: string, through: number): { streamed: string; streamedThrough: number } | undefined {
    const cached = this.prefixes.get(key(sessionId, itemId));
    if (cached?.sealed && cached.through <= through) return { streamed: cached.text, streamedThrough: cached.through };
    let streamed = "";
    let streamedThrough = 0;
    for (const event of this.readEvents(sessionId)) {
      if (event.id > through) break;
      if (event.type !== "content.delta" || event.itemId !== itemId) continue;
      streamed += event.text;
      streamedThrough = event.id;
    }
    if (!streamedThrough) return undefined;
    // Not written back: the entry may hold deltas above the cutoff.
    return { streamed, streamedThrough };
  }

  extend(sessionId: string, itemId: string, text: string, through: number): void {
    const held = this.prefixes.get(key(sessionId, itemId));
    this.remember(sessionId, itemId, { text: (held?.text ?? "") + text, through, sealed: held?.sealed === true });
  }

  remember(sessionId: string, itemId: string, entry: Prefix): void {
    const k = key(sessionId, itemId);
    this.prefixes.delete(k);
    this.prefixes.set(k, entry);
    while (this.prefixes.size > OPEN_PREFIX_LIMIT) {
      const oldest = this.prefixes.keys().next();
      if (oldest.done) break;
      this.prefixes.delete(oldest.value);
    }
  }

  drop(sessionId: string, itemId: string): void {
    this.prefixes.delete(key(sessionId, itemId));
  }
}

function key(sessionId: string, itemId: string): string {
  return `${sessionId}\n${itemId}`;
}
