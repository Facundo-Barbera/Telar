// Test-only reads into store internals, kept out of the production classes.
import fs from "node:fs";
import path from "node:path";
import type { ExecutionStore } from "../src/platform/db/execution-store";
import type { TurnPolicyRequests } from "../src/platform/db/journal-maintenance";
import type { EngineStore } from "../src/state";

type TurnUsageAggregate = {
  tokens: { input: number; output: number; cacheRead: number; cacheCreate: number; reasoning: number };
  rows: number;
};

type Row = Record<string, unknown> | undefined;
type Statement = { get(...args: unknown[]): Row; all(...args: unknown[]): Array<Record<string, unknown>> };
const db = (store: ExecutionStore) => (store as unknown as { db: { prepare(sql: string): Statement } }).db;
const executionOf = (store: EngineStore) => (store as unknown as { kernel: { executionStore: ExecutionStore } }).kernel.executionStore;

/** The SQLite execution store behind an `EngineStore`. */
export function executionStoreOf(store: EngineStore): ExecutionStore {
  return executionOf(store);
}

/**
 * Rewrite `root` as a pre-SQLite home: every session document and journal as
 * files, and no database, so the next `EngineStore` open imports it.
 * `edit` may change a document before it is written.
 */
export function toLegacyHome(store: EngineStore, root: string, edit?: (key: string, value: unknown) => unknown): void {
  const execution = executionOf(store);
  const documents = db(execution).prepare("SELECT key, value FROM documents WHERE key LIKE 'sessions/%'").all();
  const journals = new Map<string, string[]>();
  for (const sessionId of execution.sessionIds()) {
    journals.set(sessionId, execution.events(sessionId).map((event) => JSON.stringify(event)));
  }
  store.kernel.executionStore.close();
  for (const name of fs.readdirSync(root)) if (name.startsWith("execution.sqlite") || name === "execution-store.json") fs.rmSync(path.join(root, name));
  for (const row of documents) {
    const key = String(row.key);
    const value = JSON.parse(String(row.value));
    fs.mkdirSync(path.dirname(path.join(root, key)), { recursive: true });
    fs.writeFileSync(path.join(root, key), JSON.stringify(edit ? edit(key, value) : value));
  }
  for (const [sessionId, lines] of journals) {
    if (lines.length) fs.writeFileSync(path.join(root, "sessions", sessionId, "events.ndjson"), `${lines.join("\n")}\n`);
  }
}
const openPrefixes = (store: EngineStore) => (store as unknown as { prefixes: { clear(): void; size: number } }).prefixes;

/** Drop every cached item prefix, as a restart would. */
export function forgetOpenPrefixes(store: EngineStore): void {
  openPrefixes(store).clear();
}

export function openPrefixCount(store: EngineStore): number {
  return openPrefixes(store).size;
}

/** What one turn's `usage.updated` rows folded into; `undefined` until the fold ran. */
export function turnUsage(store: ExecutionStore, sessionId: string, runId: string): TurnUsageAggregate | undefined {
  const columns = db(store)
    .prepare(
      `SELECT usage_input, usage_output, usage_cache_read, usage_cache_create, usage_reasoning, usage_rows
         FROM turn_summaries WHERE session_id=? AND run_id=?`,
    )
    .get(sessionId, runId);
  if (!columns || columns.usage_rows === null || columns.usage_rows === undefined) return undefined;
  return {
    tokens: {
      input: Number(columns.usage_input ?? 0),
      output: Number(columns.usage_output ?? 0),
      cacheRead: Number(columns.usage_cache_read ?? 0),
      cacheCreate: Number(columns.usage_cache_create ?? 0),
      reasoning: Number(columns.usage_reasoning ?? 0),
    },
    rows: Number(columns.usage_rows),
  };
}

/** Requests the policy resolved in one turn, once pruned; `undefined` until then. */
export function turnPolicyRequests(store: ExecutionStore, sessionId: string, runId: string): TurnPolicyRequests | undefined {
  const row = db(store).prepare("SELECT policy_requests FROM turn_summaries WHERE session_id=? AND run_id=?").get(sessionId, runId);
  return row?.policy_requests ? JSON.parse(String(row.policy_requests)) : undefined;
}

/** Pragmas are per connection, so they are read on the store's own. */
export function durabilityPragmas(store: ExecutionStore): { synchronous: number; checkpointFullfsync: number; fullfsync: number } {
  const read = (name: string): number => Number(Object.values(db(store).prepare(`PRAGMA ${name}`).get() ?? {})[0] ?? 0);
  return { synchronous: read("synchronous"), checkpointFullfsync: read("checkpoint_fullfsync"), fullfsync: read("fullfsync") };
}

/** `<sessionId>:<eventId>` of the last turn a device barrier persisted. */
export function barrierWatermark(store: ExecutionStore): string | undefined {
  const row = db(store).prepare("SELECT value FROM metadata WHERE key=?").get("durability-barrier");
  return row ? String(row.value) : undefined;
}
