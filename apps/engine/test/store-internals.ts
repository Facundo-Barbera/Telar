// Test-only reads into store internals, kept out of the production classes.
import type { ExecutionStore, TurnPolicyRequests, TurnUsageAggregate } from "../src/execution-store";
import type { EngineStore } from "../src/state";

type Row = Record<string, unknown> | undefined;
const db = (store: ExecutionStore) => (store as unknown as { db: { prepare(sql: string): { get(...args: unknown[]): Row } } }).db;
const openPrefixes = (store: EngineStore) => (store as unknown as { openPrefixes: Map<string, unknown> }).openPrefixes;

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
