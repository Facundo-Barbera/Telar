import fs from "node:fs";
import path from "node:path";
import { autoResolution, EngineEvent, RuntimeMode, type RequestKind } from "@telar/engine-client";
import type { ExecutionStore } from "./execution-store";

/** `turn.steered`, `turn.requeued` and `turn.released` move a turn without ending it. */
export const TERMINAL_TURN_TYPES = ["turn.completed", "turn.failed", "turn.stopped", "turn.ambiguous", "turn.discarded"] as const;

// One metadata key per sweep and session. They must never be shared: `low` would start past every row the other sweep left.
export const COMPACT_WATERMARK_PREFIX = "journal-compacted/";
export const USAGE_WATERMARK_PREFIX = "journal-usage-folded/";
export const SLIM_WATERMARK_PREFIX = "journal-slimmed/";
export const REQUEST_PRUNE_WATERMARK_PREFIX = "journal-requests-pruned/";
/** The session's last terminal turn event id, written by `append`. Absent means an older store, not "none". */
export const TERMINAL_HIGH_PREFIX = "journal-terminal-high/";

/** A slimmed `item.completed` keeps `{ id }` and this flag; `rehydrate` restores the item from its `items` row. */
export const SLIM_MARKER = "itemRow";

/** The per-step bound, cut at a turn boundary, so one long session never holds the event loop. */
const SWEEP_CHUNK_IDS = 2_000;

export type TurnPolicyRequests = Record<string, Record<string, number>>;

export type SweepTotals = {
  journal: { deltas: number; starts: number; sessions: number };
  usage: { rows: number; turns: number; sessions: number; refused: number };
  slimmed: { rows: number; sessions: number };
  requests: { pairs: number; turns: number; sessions: number; refused: number };
};
export type SweepStep = "compact" | "fold" | "slim" | "prune";
const ALL_STEPS: readonly SweepStep[] = ["compact", "fold", "slim", "prune"];
type SessionSweep = { deltas: number; starts: number; slimmed: number; pairs: number; turns: number; refused: number; folded: boolean };
const emptySweep = (): SweepTotals => ({
  journal: { deltas: 0, starts: 0, sessions: 0 },
  usage: { rows: 0, turns: 0, sessions: 0, refused: 0 },
  slimmed: { rows: 0, sessions: 0 },
  requests: { pairs: 0, turns: 0, sessions: 0, refused: 0 },
});
const emptySessionSweep = (): SessionSweep => ({ deltas: 0, starts: 0, slimmed: 0, pairs: 0, turns: 0, refused: 0, folded: false });
const terminalPlaceholders = TERMINAL_TURN_TYPES.map(() => "?").join(",");
const changes = (store: ExecutionStore): number => Number(store.statement("SELECT changes() AS count").get()?.count ?? 0);
const metadataNumber = (store: ExecutionStore, key: string): number =>
  Number(store.statement("SELECT value FROM metadata WHERE key=?").get(key)?.value ?? 0);

/** The background walk: one chunk per macrotask. A walk already running is not restarted. */
export function startSweepWalk(store: ExecutionStore): void {
  if (store.closed || store.walk) return;
  let sessions: string[];
  try { sessions = store.sessionIds(); } catch { return; }
  const walk: { cancelled: boolean } = { cancelled: false };
  store.walk = walk;
  const totals = emptySweep();
  let index = 0;
  let session = emptySessionSweep();
  const done = (): void => {
    store.walk = undefined;
    if (walk.cancelled || store.closed) return;
    const { journal, usage, slimmed, requests } = totals;
    if (journal.deltas > 0 || journal.starts > 0) {
      store.housekeeping.journal = journal;
      store.onJournalCompacted?.(journal);
    }
    if (usage.turns > 0 || usage.refused > 0) store.housekeeping.usage = usage;
    if (slimmed.rows > 0) store.housekeeping.slimmed = slimmed;
    if (requests.pairs > 0 || requests.refused > 0) store.housekeeping.requests = requests;
    try { store.onRetentionSweep?.(); } catch {}
  };
  const step = (): void => {
    if (walk.cancelled || store.closed) { if (store.walk === walk) store.walk = undefined; return; }
    if (index >= sessions.length) return done();
    if (!sweepStep(store, sessions[index]!, session, totals)) {
      index += 1;
      session = emptySessionSweep();
    }
    store.sweepYield(step);
  };
  store.sweepYield(step);
}

/** The sweep, synchronously, for a caller waiting on it. */
export function sweep(store: ExecutionStore, steps: readonly SweepStep[] = ALL_STEPS): SweepTotals {
  const totals = emptySweep();
  for (const sessionId of store.sessionIds()) {
    const session = emptySessionSweep();
    while (sweepStep(store, sessionId, session, totals, steps));
  }
  return totals;
}

/** One chunk of each sweep for one session, each in its own `try`. Returns whether the session has chunks left. */
function sweepStep(store: ExecutionStore, sessionId: string, session: SessionSweep, totals: SweepTotals, steps: readonly SweepStep[] = ALL_STEPS): boolean {
  let more = false;
  if (steps.includes("compact")) try {
    const chunk = compactChunk(store, sessionId);
    session.deltas += chunk.deltas;
    session.starts += chunk.starts;
    more ||= chunk.more;
  } catch {}
  if (steps.includes("fold") && !session.folded) {
    session.folded = true;
    try { foldInto(store, sessionId, totals.usage); } catch {}
  }
  // After the compaction, which bounds it.
  if (steps.includes("slim")) try {
    const chunk = slimChunk(store, sessionId);
    session.slimmed += chunk.rows;
    more ||= chunk.more;
  } catch {}
  if (steps.includes("prune")) try {
    const chunk = pruneRequestsChunk(store, sessionId);
    session.pairs += chunk.pairs;
    session.turns += chunk.turns;
    session.refused += chunk.refused;
    more ||= chunk.more;
  } catch {}
  if (more) return true;
  const { journal, slimmed, requests } = totals;
  if (session.deltas > 0 || session.starts > 0) { journal.deltas += session.deltas; journal.starts += session.starts; journal.sessions += 1; }
  if (session.slimmed > 0) { slimmed.rows += session.slimmed; slimmed.sessions += 1; }
  requests.refused += session.refused;
  if (session.pairs > 0) { requests.pairs += session.pairs; requests.turns += session.turns; requests.sessions += 1; }
  return false;
}

function foldInto(store: ExecutionStore, sessionId: string, total: { rows: number; turns: number; sessions: number; refused: number }): void {
  let folded: { rows: number; turns: number; refused: number };
  try {
    folded = foldUsage(store, sessionId);
  } catch {
    total.refused += 1;
    return;
  }
  total.refused += folded.refused;
  if (folded.turns === 0) return;
  total.rows += folded.rows;
  total.turns += folded.turns;
  total.sessions += 1;
}

export function pruneReceipts(store: ExecutionStore): number {
  const cutoff = store.now() - store.receiptRetentionMs;
  let removed = 0;
  store.atomically(() => {
    store.statement("DELETE FROM receipts WHERE at < ?").run(cutoff);
    removed = changes(store);
  });
  return removed;
}

/** Callers hold a write scope, so the fallback's answer commits with their sweep. */
function terminalHigh(store: ExecutionStore, sessionId: string): number {
  const key = `${TERMINAL_HIGH_PREFIX}${sessionId}`;
  const stored = store.statement("SELECT value FROM metadata WHERE key=?").get(key)?.value;
  if (stored !== undefined && stored !== null && Number.isFinite(Number(stored))) return Number(stored);
  const high = Number(
    store.statement(
      `SELECT COALESCE(MAX(id),0) AS id FROM events WHERE session_id=? AND json_extract(value,'$.type') IN (${terminalPlaceholders})`,
    ).get(sessionId, ...TERMINAL_TURN_TYPES)?.id ?? 0,
  );
  store.setMetadata(key, String(high));
  return high;
}

/** Drops a delta only where its item's completed text is at least as long as the deltas summed, so it is lossless. */
function compactChunk(store: ExecutionStore, sessionId: string): { deltas: number; starts: number; more: boolean } {
  const swept = { deltas: 0, starts: 0, more: false };
  store.atomically(() => {
    // A delta still held would make its item's total look shorter than it is.
    store.drain(store.depth > 0);
    const key = `${COMPACT_WATERMARK_PREFIX}${sessionId}`;
    const low = metadataNumber(store, key);
    const settled = terminalHigh(store, sessionId);
    if (settled <= low) return;
    const high = chunkHigh(store, sessionId, low, settled);
    swept.more = high < settled;
    store.statement(
      `DELETE FROM events WHERE session_id=? AND id>? AND id<=?
         AND json_extract(value,'$.type')='content.delta'
         AND json_extract(value,'$.itemId') IN (
           SELECT streamed.item FROM
             (SELECT json_extract(value,'$.itemId') AS item,
                     SUM(LENGTH(COALESCE(json_extract(value,'$.text'),''))) AS chars
                FROM events WHERE session_id=? AND id>? AND id<=?
                 AND json_extract(value,'$.type')='content.delta' GROUP BY 1) AS streamed
             JOIN
             (SELECT json_extract(value,'$.item.id') AS item,
                     LENGTH(COALESCE(json_extract(value,'$.item.detail.text'),'')) AS chars
                FROM events WHERE session_id=? AND id>? AND id<=?
                 AND json_extract(value,'$.type')='item.completed') AS settled
             ON settled.item = streamed.item
           WHERE settled.chars >= streamed.chars)`,
    ).run(sessionId, low, high, sessionId, low, high, sessionId, low, high);
    swept.deltas = changes(store);
    // An `item.started` whose item never completed is that item's only row.
    store.statement(
      `DELETE FROM events WHERE session_id=? AND id>? AND id<=?
         AND json_extract(value,'$.type')='item.started'
         AND json_extract(value,'$.item.id') IN (
           SELECT json_extract(value,'$.item.id') FROM events
            WHERE session_id=? AND id>? AND id<=? AND json_extract(value,'$.type')='item.completed')`,
    ).run(sessionId, low, high, sessionId, low, high);
    swept.starts = changes(store);
    store.setMetadata(key, String(high));
  });
  return swept;
}

/** Parses the tokens rather than `json_extract`ing them, so the conservation check compares two computations. */
function usageTokensOf(value: string): { input: number; output: number; cacheRead: number; cacheCreate: number; reasoning: number } {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, reasoning: 0 };
  let tokens: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(value);
    const usage = (parsed as { usage?: { tokens?: unknown } } | null)?.usage?.tokens;
    if (typeof usage !== "object" || usage === null) return zero;
    tokens = usage as Record<string, unknown>;
  } catch { return zero; }
  const n = (candidate: unknown): number => (typeof candidate === "number" && Number.isFinite(candidate) ? candidate : 0);
  return { input: n(tokens.input), output: n(tokens.output), cacheRead: n(tokens.cacheRead), cacheCreate: n(tokens.cacheCreate), reasoning: n(tokens.reasoning) };
}

/** Folds each ended turn's `usage.updated` rows into its summary, keeping the last row. Throws, and rolls back, if the sums disagree. */
function foldUsage(store: ExecutionStore, sessionId: string): { rows: number; turns: number; refused: number } {
  const folded = { rows: 0, turns: 0, refused: 0 };
  store.atomically(() => {
    store.drain(store.depth > 0);
    const key = `${USAGE_WATERMARK_PREFIX}${sessionId}`;
    const low = metadataNumber(store, key);
    const high = terminalHigh(store, sessionId);
    if (high <= low) return;
    const runs = store.statement(
      `SELECT json_extract(value,'$.runId') AS run_id,
              COUNT(*) AS row_count,
              MAX(id) AS survivor,
              SUM(COALESCE(json_extract(value,'$.usage.tokens.input'),0)) AS input,
              SUM(COALESCE(json_extract(value,'$.usage.tokens.output'),0)) AS output,
              SUM(COALESCE(json_extract(value,'$.usage.tokens.cacheRead'),0)) AS cache_read,
              SUM(COALESCE(json_extract(value,'$.usage.tokens.cacheCreate'),0)) AS cache_create,
              SUM(COALESCE(json_extract(value,'$.usage.tokens.reasoning'),0)) AS reasoning
         FROM events
        WHERE session_id=? AND id>? AND id<=?
          AND json_extract(value,'$.type')='usage.updated'
          AND json_extract(value,'$.runId') IS NOT NULL
        GROUP BY 1`,
    ).all(sessionId, low, high);
    for (const run of runs) {
      const runId = String(run.run_id);
      // The run itself must have ended: a killed turn's rows are its only account.
      const settled = store.statement(
        `SELECT 1 AS ok FROM events WHERE session_id=? AND id<=?
           AND json_extract(value,'$.runId')=? AND json_extract(value,'$.type') IN (${terminalPlaceholders}) LIMIT 1`,
      ).get(sessionId, high, runId, ...TERMINAL_TURN_TYPES);
      if (!settled) continue;
      const summary = store.statement("SELECT usage_rows FROM turn_summaries WHERE session_id=? AND run_id=?").get(sessionId, runId);
      if (summary && summary.usage_rows !== null && summary.usage_rows !== undefined) continue;
      if (!summary) { folded.refused += 1; continue; }
      const rows = store.statement(
        `SELECT id, value FROM events WHERE session_id=? AND id>? AND id<=?
           AND json_extract(value,'$.type')='usage.updated' AND json_extract(value,'$.runId')=? ORDER BY id`,
      ).all(sessionId, low, high, runId);
      const totals = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, reasoning: 0 };
      for (const row of rows) {
        const tokens = usageTokensOf(String(row.value));
        totals.input += tokens.input;
        totals.output += tokens.output;
        totals.cacheRead += tokens.cacheRead;
        totals.cacheCreate += tokens.cacheCreate;
        totals.reasoning += tokens.reasoning;
      }
      const survivor = Number(run.survivor);
      if (
        rows.length !== Number(run.row_count) ||
        totals.input !== Number(run.input) ||
        totals.output !== Number(run.output) ||
        totals.cacheRead !== Number(run.cache_read) ||
        totals.cacheCreate !== Number(run.cache_create) ||
        totals.reasoning !== Number(run.reasoning) ||
        survivor !== Number(rows[rows.length - 1]?.id)
      ) {
        throw new Error(`usage fold: the aggregate does not account for every row of ${sessionId}/${runId}`);
      }
      store.statement(
        `DELETE FROM events WHERE session_id=? AND id>? AND id<=? AND id<>?
           AND json_extract(value,'$.type')='usage.updated' AND json_extract(value,'$.runId')=?`,
      ).run(sessionId, low, high, survivor, runId);
      const went = changes(store);
      if (went !== rows.length - 1) throw new Error(`usage fold: ${went} rows went where ${rows.length - 1} were accounted for`);
      store.statement(
        `UPDATE turn_summaries SET usage_input=?, usage_output=?, usage_cache_read=?,
           usage_cache_create=?, usage_reasoning=?, usage_rows=? WHERE session_id=? AND run_id=?`,
      ).run(totals.input, totals.output, totals.cacheRead, totals.cacheCreate, totals.reasoning, rows.length, sessionId, runId);
      if (changes(store) !== 1) throw new Error(`usage fold: the aggregate for ${sessionId}/${runId} was not recorded`);
      folded.rows += went;
      folded.turns += 1;
    }
    store.setMetadata(key, String(high));
  });
  return folded;
}

/** Slims only where the `items` row equals the event's item, never a notification, and never past the compaction. */
function slimChunk(store: ExecutionStore, sessionId: string): { rows: number; more: boolean } {
  let slimmed = 0;
  let more = false;
  store.atomically(() => {
    const key = `${SLIM_WATERMARK_PREFIX}${sessionId}`;
    const low = metadataNumber(store, key);
    const compacted = metadataNumber(store, `${COMPACT_WATERMARK_PREFIX}${sessionId}`);
    const settled = Math.min(terminalHigh(store, sessionId), compacted);
    if (settled <= low) return;
    const high = chunkHigh(store, sessionId, low, settled);
    more = high < settled;
    store.statement(
      `UPDATE events SET value = json_set(json_set(value,'$.item',json_object('id',json_extract(value,'$.item.id'))),'$.${SLIM_MARKER}',json('true'))
        WHERE session_id=? AND id>? AND id<=?
          AND json_extract(value,'$.type')='item.completed'
          AND json_extract(value,'$.${SLIM_MARKER}') IS NULL
          AND COALESCE(json_extract(value,'$.item.detail.type'),'') <> 'notification'
          AND EXISTS (SELECT 1 FROM items WHERE items.session_id=events.session_id
                        AND items.item_id=json_extract(events.value,'$.item.id')
                        AND json(items.value)=json(json_extract(events.value,'$.item')))`,
    ).run(sessionId, low, high);
    slimmed = changes(store);
    store.setMetadata(key, String(high));
  });
  return { rows: slimmed, more };
}

/** Where a step over `(low, high]` stops: at a terminal turn event, so a request pair and its turn's end share a range. */
function chunkHigh(store: ExecutionStore, sessionId: string, low: number, high: number): number {
  if (high - low <= SWEEP_CHUNK_IDS) return high;
  const within = store.statement(
    `SELECT MAX(id) AS id FROM events WHERE session_id=? AND id>? AND id<=? AND json_extract(value,'$.type') IN (${terminalPlaceholders})`,
  ).get(sessionId, low, low + SWEEP_CHUNK_IDS, ...TERMINAL_TURN_TYPES)?.id;
  if (within !== undefined && within !== null) return Number(within);
  const past = store.statement(
    `SELECT id FROM events WHERE session_id=? AND id>? AND id<=? AND json_extract(value,'$.type') IN (${terminalPlaceholders}) ORDER BY id LIMIT 1`,
  ).get(sessionId, low + SWEEP_CHUNK_IDS, high, ...TERMINAL_TURN_TYPES)?.id;
  return past !== undefined && past !== null ? Number(past) : high;
}

type Opened = { id: number; runId: string; kind: string; decision: string; mode: string | undefined };
type Resolved = { id: number; runId: string; decision: string };
type RequestEvent = { requestId?: string; decision?: string; resolvedBy?: string; request?: { id?: string; state?: string; resolvedBy?: string; decision?: string; detail?: { kind?: string } } };

function readRequestPairs(store: ExecutionStore, sessionId: string, low: number, high: number) {
  const rows = store.statement(
    `SELECT id, json_extract(value,'$.type') AS type, json_extract(value,'$.runId') AS run_id,
            CASE WHEN json_extract(value,'$.type') LIKE 'request.%' THEN value END AS value,
            json_extract(value,'$.session.runtimeMode') AS mode
       FROM events WHERE session_id=? AND id>? AND id<=?
        AND json_extract(value,'$.type') IN ('request.opened','request.resolved','session.created','session.updated',${terminalPlaceholders})
      ORDER BY id`,
  ).all(sessionId, low, high, ...TERMINAL_TURN_TYPES);
  const opened = new Map<string, Opened[]>();
  const resolved = new Map<string, Resolved[]>();
  const ended = new Set<string>();
  const carried = store.pruneMode?.sessionId === sessionId && store.pruneMode.at === low ? store.pruneMode : undefined;
  let mode: string | undefined = carried?.mode;
  let modeRead = carried !== undefined;
  for (const row of rows) {
    const type = String(row.type);
    if ((TERMINAL_TURN_TYPES as readonly string[]).includes(type)) {
      if (typeof row.run_id === "string") ended.add(row.run_id);
      continue;
    }
    if (type === "session.created" || type === "session.updated") {
      mode = typeof row.mode === "string" ? row.mode : undefined;
      modeRead = true;
      continue;
    }
    let event: RequestEvent;
    try { event = JSON.parse(String(row.value)); } catch { continue; }
    const runId = typeof row.run_id === "string" ? row.run_id : "";
    if (type === "request.opened") {
      const request = event.request;
      if (!request?.id) continue;
      if (!modeRead) {
        const before = store.statement(
          `SELECT json_extract(value,'$.session.runtimeMode') AS mode FROM events WHERE session_id=? AND id<=?
             AND json_extract(value,'$.type') IN ('session.created','session.updated') ORDER BY id DESC LIMIT 1`,
        ).get(sessionId, low);
        mode = typeof before?.mode === "string" ? before.mode : undefined;
        modeRead = true;
      }
      const list = opened.get(request.id) ?? [];
      list.push({
        id: Number(row.id), runId,
        kind: request.state === "resolved" && request.resolvedBy === "policy" ? String(request.detail?.kind ?? "") : "",
        decision: String(request.decision ?? ""), mode,
      });
      opened.set(request.id, list);
    } else if (event.requestId) {
      const list = resolved.get(event.requestId) ?? [];
      list.push({ id: Number(row.id), runId, decision: event.resolvedBy === "policy" ? String(event.decision ?? "") : "" });
      resolved.set(event.requestId, list);
    }
  }
  return { opened, resolved, ended, mode, modeRead };
}

/** Prunes only pairs the policy resolved in a turn that ended in the same range, counted per turn. */
function pruneRequestsChunk(store: ExecutionStore, sessionId: string): { pairs: number; turns: number; refused: number; more: boolean } {
  const pruned = { pairs: 0, turns: 0, refused: 0, more: false };
  store.atomically(() => {
    store.drain(store.depth > 0);
    const key = `${REQUEST_PRUNE_WATERMARK_PREFIX}${sessionId}`;
    const low = metadataNumber(store, key);
    const settledHigh = terminalHigh(store, sessionId);
    if (settledHigh <= low) return;
    const high = chunkHigh(store, sessionId, low, settledHigh);
    pruned.more = high < settledHigh;
    const { opened, resolved, ended, mode, modeRead } = readRequestPairs(store, sessionId, low, high);

    const byRun = new Map<string, { ids: number[]; counts: TurnPolicyRequests }>();
    for (const [requestId, [open, ...extraOpen]] of opened) {
      const [close, ...extraClose] = resolved.get(requestId) ?? [];
      if (!open || !close || extraOpen.length > 0 || extraClose.length > 0) continue;
      if (!open.kind || !open.decision || !open.runId) continue;
      if (close.decision !== open.decision || close.runId !== open.runId || close.id <= open.id) continue;
      if (!open.mode || !(RuntimeMode.options as readonly string[]).includes(open.mode)) continue;
      if (autoResolution(open.mode as RuntimeMode, open.kind as RequestKind) !== open.decision) continue;
      if (!ended.has(open.runId)) continue;
      const run = byRun.get(open.runId) ?? { ids: [], counts: {} };
      run.ids.push(open.id, close.id);
      const kind = (run.counts[open.kind] ??= {});
      kind[open.decision] = (kind[open.decision] ?? 0) + 1;
      byRun.set(open.runId, run);
    }

    for (const [runId, run] of byRun) {
      const summary = store.statement("SELECT policy_requests FROM turn_summaries WHERE session_id=? AND run_id=?").get(sessionId, runId);
      if (!summary) { pruned.refused += 1; continue; }
      const counts: TurnPolicyRequests = summary.policy_requests ? JSON.parse(String(summary.policy_requests)) : {};
      for (const [kind, decisions] of Object.entries(run.counts)) {
        const into = (counts[kind] ??= {});
        for (const [decision, count] of Object.entries(decisions)) into[decision] = (into[decision] ?? 0) + count;
      }
      let went = 0;
      for (const id of run.ids) {
        store.statement("DELETE FROM events WHERE session_id=? AND id=?").run(sessionId, id);
        went += changes(store);
      }
      if (went !== run.ids.length) throw new Error(`request prune: ${went} rows went where ${run.ids.length} were counted`);
      store.statement("UPDATE turn_summaries SET policy_requests=? WHERE session_id=? AND run_id=?")
        .run(JSON.stringify(counts), sessionId, runId);
      pruned.pairs += run.ids.length / 2;
      pruned.turns += 1;
    }
    store.setMetadata(key, String(high));
    // Keyed by the watermark: after a rollback the next chunk reads the mode itself.
    store.pruneMode = modeRead ? { sessionId, at: high, mode } : undefined;
  });
  return pruned;
}

export function rehydrate(store: ExecutionStore, sessionId: string, value: string): EngineEvent {
  const event = JSON.parse(value) as EngineEvent & { item?: { id?: string }; [SLIM_MARKER]?: boolean };
  if (event[SLIM_MARKER] !== true) return event;
  const row = store.statement("SELECT value FROM items WHERE session_id=? AND item_id=?").get(sessionId, event.item?.id ?? "");
  if (!row) return event;
  event.item = JSON.parse(String(row.value));
  delete event[SLIM_MARKER];
  return event;
}

/** Puts a stub's item back before its `items` row changes, so `rehydrate` never returns the new value. */
export function unslim(store: ExecutionStore, sessionId: string, itemId: string, next: string): void {
  const old = store.statement("SELECT value, json_extract(value,'$.status') AS status FROM items WHERE session_id=? AND item_id=?")
    .get(sessionId, itemId);
  if (!old || old.status === "inProgress" || String(old.value) === next) return;
  const slimmedTo = store.statement("SELECT value FROM metadata WHERE key=?").get(`${SLIM_WATERMARK_PREFIX}${sessionId}`)?.value;
  if (slimmedTo === undefined || slimmedTo === null) return;
  store.statement(
    `UPDATE events SET value = json_remove(json_set(value,'$.item',json(?)),'$.${SLIM_MARKER}')
      WHERE session_id=? AND id<=? AND json_extract(value,'$.${SLIM_MARKER}') IS NOT NULL
        AND json_extract(value,'$.item.id')=?`,
  ).run(String(old.value), sessionId, Number(slimmedTo), itemId);
}

function journalBytes(root: string): number {
  const file = path.join(root, "execution.sqlite");
  let bytes = 0;
  for (const name of [file, `${file}-wal`, `${file}-shm`]) {
    try { bytes += fs.statSync(name).size; } catch {}
  }
  return bytes;
}

/** Sweeps, then VACUUMs. Only on request: the VACUUM holds an exclusive lock for tens of seconds on a large store. */
export function reclaim(store: ExecutionStore): { before: number; after: number; deltas: number; starts: number; sessions: number; usage: number } {
  const before = journalBytes(store.root);
  const { journal, usage } = sweep(store);
  store.flush();
  store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  store.db.exec("VACUUM");
  store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  return { before, after: journalBytes(store.root), ...journal, usage: usage.rows };
}

/** A consistent copy without touching this database. `VACUUM INTO` uses the umask, so the copy is chmodded to match. */
export function vacuumInto(store: ExecutionStore, file: string): void {
  if (fs.existsSync(file)) throw new Error("Copy destination must not already exist");
  store.flush();
  store.statement("VACUUM INTO ?").run(file);
  fs.chmodSync(file, 0o600);
}
