import fs from "node:fs";
import path from "node:path";
import { idleSince, isShelved, settlingActivityOf } from "@telar/engine-client";
import { atomicWrite } from "../fs/atomic";
import type { ExecutionStore } from "./execution-store";
import { TERMINAL_HIGH_PREFIX, TERMINAL_TURN_TYPES } from "./journal-maintenance";
import { allSessionRows, itemRows, itemsAreRows, prefixRange, turnSummaryStates, type SessionIndexRow } from "./tables";

// Retention drops a settled session's raw `events` and nothing else: `session.json` must stay, or the next
// start's reconcile removes the session from the rail. Deleted rows go to the freelist until Reclaim.

/** The highest event id a retired session held, so `cursor` never restarts at 1 after its journal is gone. */
export const JOURNAL_FLOOR_PREFIX = "journal-floor/";

/** The five endings as `turn_summaries` records them; `steered` moves a turn rather than ending it. */
const TERMINAL_TURN_STATES = ["completed", "failed", "stopped", "ambiguous", "discarded"] as const;

const EXPORT_PAGE = 1_000;

type Window = { idleBefore: number; now: number };

/** The one predicate the preview and the sweep share: idle past the window and shelvable with the clock at zero. */
function retirable(store: ExecutionStore, window: Window): SessionIndexRow[] {
  return allSessionRows(store).filter(
    (row) =>
      idleSince(row) < window.idleBefore &&
      isShelved({ ...row }, settlingActivityOf(row), { now: window.now, autoSettleAfterHours: 0 }),
  );
}

/** Bytes need a scan of every row, so they are computed only when asked for. */
export function retentionPreview(store: ExecutionStore, window: Window, options: { bytes?: boolean } = {}): { sessions: number; events: number; bytes?: number } {
  const rows = retirable(store, window);
  let events = 0;
  let bytes = 0;
  for (const row of rows) {
    events += Number(store.statement("SELECT COUNT(*) AS count FROM events WHERE session_id=?").get(row.id)?.count ?? 0);
    if (options.bytes)
      bytes += Number(store.statement("SELECT COALESCE(SUM(LENGTH(CAST(value AS BLOB))),0) AS bytes FROM events WHERE session_id=?").get(row.id)?.bytes ?? 0);
  }
  return { sessions: rows.length, events, ...(options.bytes ? { bytes } : {}) };
}

/** One session in `exportLegacy`'s shape, paged. Returns the line count the retirement guard compares against. */
export function exportSession(store: ExecutionStore, sessionId: string, destination: string): { documents: number; events: number } {
  if (fs.existsSync(destination)) throw new Error("Export destination must not already exist");
  store.flush();
  const directory = path.join(destination, "sessions", sessionId);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const [low, high] = prefixRange(`sessions/${sessionId}/`);
  let documents = 0;
  for (const row of store.statement("SELECT key,value FROM documents WHERE key >= ? AND key < ? ORDER BY key").all(low, high)) {
    // Offset indexes describe this store's compact text, not the exported bytes.
    if (String(row.key).endsWith(".index.json")) continue;
    atomicWrite(path.join(destination, String(row.key)), JSON.parse(String(row.value)));
    documents += 1;
  }
  if (itemsAreRows(store, sessionId)) {
    fs.writeFileSync(path.join(directory, "items.json"), `{"items":[${itemRows(store, sessionId).join(",")}]}`, { mode: 0o600 });
    documents += 1;
  }
  const handle = fs.openSync(path.join(directory, "events.ndjson"), "w", 0o600);
  let events = 0;
  try {
    let after = 0;
    for (;;) {
      const page = store.events(sessionId, after, EXPORT_PAGE);
      if (page.length === 0) break;
      fs.writeSync(handle, page.map((event) => `${JSON.stringify(event)}\n`).join(""));
      events += page.length;
      after = page[page.length - 1]!.id;
      if (page.length < EXPORT_PAGE) break;
    }
  } finally { fs.closeSync(handle); }
  return { documents, events };
}

function itemsReadable(store: ExecutionStore, sessionId: string): boolean {
  if (itemsAreRows(store, sessionId))
    return store.statement("SELECT COUNT(*) AS bad FROM items WHERE session_id=? AND json_valid(value)=0").get(sessionId)?.bad === 0;
  const blob = store.statement("SELECT json_array_length(value,'$.items') AS count FROM documents WHERE key=?")
    .get(`sessions/${sessionId}/items.json`);
  return blob === undefined || blob.count !== null;
}

/**
 * Drops one session's journal only if every ended turn has a summary, its items parse, and the export
 * holds exactly the rows being deleted. A refusal skips the session and is counted, never thrown.
 */
export function retireSession(store: ExecutionStore, sessionId: string, options: { exportTo: string }): { retired: boolean; events: number; refused?: "summaries" | "items" | "export" } {
  const held = Number(store.statement("SELECT COUNT(*) AS count FROM events WHERE session_id=?").get(sessionId)?.count ?? 0);
  if (held === 0 && store.held().every((event) => event.sessionId !== sessionId)) return { retired: false, events: 0 };

  const summaries = turnSummaryStates(store, sessionId).filter((row) => (TERMINAL_TURN_STATES as readonly string[]).includes(row.state)).length;
  const placeholders = TERMINAL_TURN_TYPES.map(() => "?").join(",");
  const ended = Number(
    store.statement(
      `SELECT COUNT(DISTINCT json_extract(value,'$.runId')) AS count FROM events
        WHERE session_id=? AND json_extract(value,'$.type') IN (${placeholders})`,
    ).get(sessionId, ...TERMINAL_TURN_TYPES)?.count ?? 0,
  );
  if (summaries !== ended) return { retired: false, events: 0, refused: "summaries" };
  try {
    if (!itemsReadable(store, sessionId)) return { retired: false, events: 0, refused: "items" };
  } catch { return { retired: false, events: 0, refused: "items" }; }

  let exported: { documents: number; events: number };
  try {
    exported = exportSession(store, sessionId, path.join(options.exportTo, sessionId));
  } catch { return { retired: false, events: 0, refused: "export" }; }
  let outcome: { retired: boolean; events: number; refused?: "export" } = { retired: false, events: 0, refused: "export" };
  store.atomically(() => {
    store.drain(store.depth > 0);
    const rows = Number(store.statement("SELECT COUNT(*) AS count FROM events WHERE session_id=?").get(sessionId)?.count ?? 0);
    // A turn that landed after the export makes the copy short; the next sweep exports again.
    if (rows !== exported.events) return;
    const high = Number(store.statement("SELECT COALESCE(MAX(id),0) AS id FROM events WHERE session_id=?").get(sessionId)?.id ?? 0);
    store.statement("DELETE FROM events WHERE session_id=?").run(sessionId);
    store.setMetadata(`${JOURNAL_FLOOR_PREFIX}${sessionId}`, String(Math.max(high, store.cursors.get(sessionId) ?? 0)));
    store.statement("DELETE FROM metadata WHERE key=?").run(`${TERMINAL_HIGH_PREFIX}${sessionId}`);
    outcome = { retired: true, events: rows };
  });
  return outcome;
}

export function retireJournal(store: ExecutionStore, window: Window, options: { exportTo: string }): { retired: number; skipped: number; events: number } {
  const total = { retired: 0, skipped: 0, events: 0 };
  for (const row of retirable(store, window)) {
    const went = retireSession(store, row.id, options);
    if (went.retired) { total.retired += 1; total.events += went.events; }
    else if (went.refused) total.skipped += 1;
  }
  return total;
}
