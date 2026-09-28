import path from "node:path";
import type { SessionActivity } from "@telar/engine-client";
import type { ScheduleRule } from "../../domains/schedules";
import type { TurnSummary } from "../../domains/turns";
import type { ExecutionStore } from "./execution-store";
import { rehydrate, SLIM_MARKER, unslim } from "./journal-maintenance";

/** The scalars the rail decides on, promoted out of `session.json`; payload stays in the document. */
export type SessionIndexRow = {
  id: string;
  projectId?: string;
  state: "active" | "archived";
  updatedAt: number;
  createdAt: number;
  archived: boolean;
  draft: boolean;
  readAt?: number;
  settledOverride?: "settled" | "active";
  settledAt?: number;
  snoozedUntil?: number;
  snoozedAt?: number;
  wokeAt?: number;
  lastTurnSequence?: number;
  lastReadTurnSequence?: number;
  lastTurnEndedAt?: number;
  lastTurnFailed?: boolean;
  activity: SessionActivity;
  activityAt?: number;
  title?: string;
  branch?: string;
};

export type ScheduleRow = {
  id: string;
  sessionId: string;
  prompt: string;
  rule: ScheduleRule;
  /** An IANA zone name, never an offset. */
  zone: string;
  enabled: boolean;
  createdAt: number;
  nextRunAt: number;
  lastRunAt?: number;
  lastRunId?: string;
  lastRunStatus?: "fired" | "skipped";
  lastSkippedAt?: number;
};

type Columns = Record<string, unknown>;

const optionalNumber = <K extends string>(key: K, value: unknown): { [P in K]?: number } =>
  (value === null || value === undefined ? {} : { [key]: Number(value) }) as { [P in K]?: number };
const optionalString = <K extends string>(key: K, value: unknown): { [P in K]?: string } =>
  (value === null || value === undefined ? {} : { [key]: String(value) }) as { [P in K]?: string };

function scheduleFromColumns(row: Columns): ScheduleRow {
  let rule: ScheduleRule;
  try {
    rule = JSON.parse(String(row.rule)) as ScheduleRule;
  } catch {
    // An unreadable rule never fires but stays visible.
    rule = { kind: "interval", everyMs: Number.MAX_SAFE_INTEGER };
  }
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    prompt: String(row.prompt),
    rule,
    zone: String(row.zone),
    enabled: Number(row.enabled) === 1,
    createdAt: Number(row.created_at ?? 0),
    nextRunAt: Number(row.next_run_at ?? 0),
    ...optionalNumber("lastRunAt", row.last_run_at),
    ...(row.last_run_id ? { lastRunId: String(row.last_run_id) } : {}),
    ...(row.last_run_status ? { lastRunStatus: String(row.last_run_status) as ScheduleRow["lastRunStatus"] } : {}),
    ...optionalNumber("lastSkippedAt", row.last_skipped_at),
  };
}

function rowFromColumns(columns: Columns): SessionIndexRow {
  const override = columns.settled_override === null || columns.settled_override === undefined
    ? undefined
    : String(columns.settled_override) === "settled" ? "settled" as const : "active" as const;
  return {
    id: String(columns.id),
    ...optionalString("projectId", columns.project_id),
    state: String(columns.state) === "archived" ? "archived" : "active",
    updatedAt: Number(columns.updated_at),
    createdAt: Number(columns.created_at),
    archived: Number(columns.archived) === 1,
    draft: Number(columns.draft) === 1,
    ...optionalNumber("readAt", columns.read_at),
    ...(override === undefined ? {} : { settledOverride: override }),
    ...optionalNumber("settledAt", columns.settled_at),
    ...optionalNumber("snoozedUntil", columns.snoozed_until),
    ...optionalNumber("snoozedAt", columns.snoozed_at),
    ...optionalNumber("wokeAt", columns.woke_at),
    ...optionalNumber("lastTurnSequence", columns.last_turn_sequence),
    ...optionalNumber("lastReadTurnSequence", columns.last_read_turn_sequence),
    ...optionalNumber("lastTurnEndedAt", columns.last_turn_ended_at),
    ...(Number(columns.last_turn_failed) === 1 ? { lastTurnFailed: true } : {}),
    activity: String(columns.activity) as SessionIndexRow["activity"],
    ...optionalNumber("activityAt", columns.activity_at),
    ...optionalString("title", columns.title),
    ...optionalString("branch", columns.branch),
  };
}

function turnFromColumns(columns: Columns): TurnSummary {
  let titles: string[] = [];
  try {
    const parsed: unknown = JSON.parse(String(columns.item_titles ?? "[]"));
    if (Array.isArray(parsed)) titles = parsed.map((title) => String(title));
  } catch {}
  return {
    sessionId: String(columns.session_id),
    runId: String(columns.run_id),
    sequence: Number(columns.sequence),
    ...(columns.origin === null || columns.origin === undefined ? {} : { origin: String(columns.origin) as TurnSummary["origin"] }),
    state: String(columns.state) as TurnSummary["state"],
    ...optionalNumber("startedAt", columns.started_at),
    ...optionalNumber("endedAt", columns.ended_at),
    input: String(columns.input_line ?? ""),
    itemCount: Number(columns.item_count ?? 0),
    itemTitles: titles,
    answerHead: String(columns.answer_head ?? ""),
    answerChars: Number(columns.answer_chars ?? 0),
    ...optionalString("failure", columns.failure_text),
  };
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** `[prefix, prefix+1)`: an index seek on `documents.key`, which `LIKE` and `substr` are not. Prefixes end in `/`. */
export function prefixRange(prefix: string): [string, string] {
  const last = prefix.charCodeAt(prefix.length - 1);
  return [prefix, `${prefix.slice(0, -1)}${String.fromCharCode(last + 1)}`];
}

export function sessionIds(store: ExecutionStore): string[] {
  const [low, high] = prefixRange("sessions/");
  return store.statement("SELECT key FROM documents WHERE key >= ? AND key < ? AND key LIKE '%/session.json' ORDER BY key")
    .all(low, high).map((row) => String(row.key).split("/")[1]!);
}

export function sessionRowGaps(store: ExecutionStore): { missing: string[]; orphaned: string[] } {
  const documents = new Set(sessionIds(store));
  const rows = new Set(store.statement("SELECT id FROM sessions").all().map((row) => String(row.id)));
  return {
    missing: [...documents].filter((id) => !rows.has(id)),
    orphaned: [...rows].filter((id) => !documents.has(id)),
  };
}

export function allSessionRows(store: ExecutionStore): SessionIndexRow[] {
  return store.statement("SELECT * FROM sessions").all().map(rowFromColumns);
}

/** Unordered on purpose: the index cannot serve the caller's order, so an ORDER BY here only adds a sort. */
export function liveSessionRows(store: ExecutionStore): SessionIndexRow[] {
  return store.statement("SELECT * FROM sessions WHERE archived = 0").all().map(rowFromColumns);
}

export function dueSnoozeWakes(store: ExecutionStore): SessionIndexRow[] {
  return store.statement("SELECT * FROM sessions WHERE snoozed_until IS NOT NULL AND woke_at IS NULL AND archived = 0")
    .all()
    .map(rowFromColumns);
}

export function sessionRow(store: ExecutionStore, sessionId: string): SessionIndexRow | undefined {
  const columns = store.statement("SELECT * FROM sessions WHERE id=?").get(sessionId);
  return columns ? rowFromColumns(columns) : undefined;
}

export function projectSessionRows(store: ExecutionStore, projectId: string): SessionIndexRow[] {
  return store.statement("SELECT * FROM sessions WHERE project_id=?").all(projectId).map(rowFromColumns);
}

/** Newest active session per project. Archived and projectless sessions don't vote. */
export function projectActivity(store: ExecutionStore): { projectId: string; updatedAt: number }[] {
  return store.statement(
    "SELECT project_id, MAX(updated_at) AS updated_at FROM sessions WHERE archived = 0 AND project_id IS NOT NULL GROUP BY project_id",
  ).all().map((row) => ({ projectId: String(row.project_id), updatedAt: Number(row.updated_at) }));
}

/** Call inside the transaction that wrote the row's document. */
export function writeSessionRow(store: ExecutionStore, row: SessionIndexRow): void {
  store.statement(`INSERT INTO sessions(
      id, project_id, state, archived, draft, created_at, updated_at, read_at, settled_override, settled_at,
      snoozed_until, snoozed_at, last_turn_sequence, last_read_turn_sequence, last_turn_ended_at, last_turn_failed,
      activity, activity_at, title, branch, woke_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      project_id=excluded.project_id, state=excluded.state, archived=excluded.archived, draft=excluded.draft,
      created_at=excluded.created_at, updated_at=excluded.updated_at, read_at=excluded.read_at,
      settled_override=excluded.settled_override, settled_at=excluded.settled_at,
      snoozed_until=excluded.snoozed_until, snoozed_at=excluded.snoozed_at,
      last_turn_sequence=excluded.last_turn_sequence, last_read_turn_sequence=excluded.last_read_turn_sequence,
      last_turn_ended_at=excluded.last_turn_ended_at, last_turn_failed=excluded.last_turn_failed,
      activity=excluded.activity, activity_at=excluded.activity_at,
      title=excluded.title, branch=excluded.branch, woke_at=excluded.woke_at`).run(
    row.id, row.projectId ?? null, row.state, row.archived ? 1 : 0, row.draft ? 1 : 0,
    row.createdAt, row.updatedAt, row.readAt ?? null, row.settledOverride ?? null, row.settledAt ?? null,
    row.snoozedUntil ?? null, row.snoozedAt ?? null, row.lastTurnSequence ?? null, row.lastReadTurnSequence ?? null,
    row.lastTurnEndedAt ?? null, row.lastTurnFailed ? 1 : 0, row.activity, row.activityAt ?? null,
    row.title ?? null, row.branch ?? null, row.wokeAt ?? null);
  if (store.searchIndex !== "fts5") return;
  store.statement("DELETE FROM session_search WHERE session_id=? AND run_id=''").run(row.id);
  store.statement("INSERT INTO session_search(text, session_id, run_id) VALUES(?,?,'')").run(`${row.title ?? ""}\n${row.branch ?? ""}`, row.id);
}

export function deleteSessionRow(store: ExecutionStore, sessionId: string): void {
  store.statement("DELETE FROM sessions WHERE id=?").run(sessionId);
  store.statement("DELETE FROM turn_summaries WHERE session_id=?").run(sessionId);
  if (store.searchIndex === "fts5") store.statement("DELETE FROM session_search WHERE session_id=?").run(sessionId);
}

export function dueSchedules(store: ExecutionStore, now: number): ScheduleRow[] {
  return store.statement("SELECT * FROM schedules WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at")
    .all(now)
    .map(scheduleFromColumns);
}

export function listSchedules(store: ExecutionStore, sessionId?: string): ScheduleRow[] {
  return (
    sessionId === undefined
      ? store.statement("SELECT * FROM schedules ORDER BY next_run_at").all()
      : store.statement("SELECT * FROM schedules WHERE session_id = ? ORDER BY next_run_at").all(sessionId)
  ).map(scheduleFromColumns);
}

export function readSchedule(store: ExecutionStore, id: string): ScheduleRow | undefined {
  const found = store.statement("SELECT * FROM schedules WHERE id = ?").all(id);
  return found.length > 0 ? scheduleFromColumns(found[0]!) : undefined;
}

export function writeSchedule(store: ExecutionStore, row: ScheduleRow): void {
  store.statement(
    `INSERT INTO schedules (id, session_id, prompt, rule, zone, enabled, created_at, next_run_at, last_run_at, last_run_id, last_run_status, last_skipped_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id, prompt=excluded.prompt, rule=excluded.rule, zone=excluded.zone,
       enabled=excluded.enabled, next_run_at=excluded.next_run_at, last_run_at=excluded.last_run_at, last_run_id=excluded.last_run_id,
       last_run_status=excluded.last_run_status, last_skipped_at=excluded.last_skipped_at`,
  ).run(
    row.id, row.sessionId, row.prompt, JSON.stringify(row.rule), row.zone, row.enabled ? 1 : 0, row.createdAt, row.nextRunAt,
    row.lastRunAt ?? null, row.lastRunId ?? null, row.lastRunStatus ?? null, row.lastSkippedAt ?? null,
  );
}

export function deleteSchedule(store: ExecutionStore, id: string): boolean {
  const before = store.statement("SELECT id FROM schedules WHERE id = ?").all(id).length;
  store.statement("DELETE FROM schedules WHERE id = ?").run(id);
  return before > 0;
}

export function turnSummaryStates(store: ExecutionStore, sessionId: string): Array<{ runId: string; state: string }> {
  return store.statement("SELECT run_id, state FROM turn_summaries WHERE session_id=?")
    .all(sessionId)
    .map((row) => ({ runId: String(row.run_id), state: String(row.state) }));
}

export function writeTurnSummary(store: ExecutionStore, row: TurnSummary): void {
  store.statement(`INSERT INTO turn_summaries(
      session_id, run_id, sequence, origin, state, started_at, ended_at,
      input_line, item_count, item_titles, answer_head, answer_chars, failure_text)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(session_id, run_id) DO UPDATE SET
      sequence=excluded.sequence, origin=excluded.origin, state=excluded.state,
      started_at=excluded.started_at, ended_at=excluded.ended_at, input_line=excluded.input_line,
      item_count=excluded.item_count, item_titles=excluded.item_titles,
      answer_head=excluded.answer_head, answer_chars=excluded.answer_chars,
      failure_text=excluded.failure_text`).run(
    row.sessionId, row.runId, row.sequence, row.origin ?? null, row.state,
    row.startedAt ?? null, row.endedAt ?? null, row.input, row.itemCount,
    JSON.stringify(row.itemTitles), row.answerHead, row.answerChars, row.failure ?? null);
  if (store.searchIndex !== "fts5") return;
  // fts5 has no upsert, and an UPDATE would leave the old terms matchable.
  store.statement("DELETE FROM session_search WHERE session_id=? AND run_id=?").run(row.sessionId, row.runId);
  store.statement("INSERT INTO session_search(text, session_id, run_id) VALUES(?,?,?)")
    .run(`${row.input}\n${row.answerHead}`, row.sessionId, row.runId);
}

export function deleteTurnSummary(store: ExecutionStore, sessionId: string, runId: string): void {
  store.statement("DELETE FROM turn_summaries WHERE session_id=? AND run_id=?").run(sessionId, runId);
  if (store.searchIndex === "fts5") store.statement("DELETE FROM session_search WHERE session_id=? AND run_id=?").run(sessionId, runId);
}

/** Newest first, keyset by sequence so a live session pages without drops or repeats. */
export function outlineRows(store: ExecutionStore, sessionId: string, before: number | undefined, limit: number): TurnSummary[] {
  const rows = before === undefined
    ? store.statement("SELECT * FROM turn_summaries WHERE session_id=? ORDER BY sequence DESC LIMIT ?").all(sessionId, limit)
    : store.statement("SELECT * FROM turn_summaries WHERE session_id=? AND sequence<? ORDER BY sequence DESC LIMIT ?").all(sessionId, before, limit);
  return rows.map(turnFromColumns);
}

export function turnSummary(store: ExecutionStore, sessionId: string, runId: string): TurnSummary | undefined {
  const columns = store.statement("SELECT * FROM turn_summaries WHERE session_id=? AND run_id=?").get(sessionId, runId);
  return columns ? turnFromColumns(columns) : undefined;
}

export function latestAnsweredTurn(store: ExecutionStore, sessionId: string): TurnSummary | undefined {
  const columns = store.statement(
    "SELECT * FROM turn_summaries WHERE session_id=? AND state='completed' AND answer_chars>0 ORDER BY sequence DESC LIMIT 1",
  ).get(sessionId);
  return columns ? turnFromColumns(columns) : undefined;
}

export function turnSummaryCount(store: ExecutionStore, sessionId: string): number {
  return Number(store.statement("SELECT COUNT(*) AS count FROM turn_summaries WHERE session_id=?").get(sessionId)?.count ?? 0);
}

export function turnSummaryGaps(store: ExecutionStore): string[] {
  const summarised = new Set(store.statement("SELECT DISTINCT session_id FROM turn_summaries").all().map((row) => String(row.session_id)));
  return sessionIds(store).filter((id) => !summarised.has(id));
}

export function searchTurnText(store: ExecutionStore, terms: string[], scan: number): Array<{ sessionId: string; runId: string; text: string }> {
  if (terms.length === 0) return [];
  if (store.searchIndex === "fts5") {
    // Every term quoted as a phrase, so user text is never fts5 syntax.
    const query = terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(" AND ");
    return store.statement("SELECT text, session_id, run_id FROM session_search WHERE session_search MATCH ? ORDER BY rank LIMIT ?")
      .all(query, scan)
      .map((row) => ({ sessionId: String(row.session_id), runId: String(row.run_id), text: String(row.text) }));
  }
  const like = `%${escapeLike(terms[0]!)}%`;
  const rows = store.statement(
    `SELECT session_id, run_id, input_line || char(10) || answer_head AS text FROM turn_summaries
       WHERE input_line LIKE ? ESCAPE '\\' OR answer_head LIKE ? ESCAPE '\\'
       ORDER BY session_id, sequence DESC LIMIT ?`,
  ).all(like, like, scan);
  const titles = store.statement(
    `SELECT id AS session_id, '' AS run_id, COALESCE(title,'') || char(10) || COALESCE(branch,'') AS text FROM sessions
       WHERE title LIKE ? ESCAPE '\\' OR branch LIKE ? ESCAPE '\\' LIMIT ?`,
  ).all(like, like, scan);
  return [...titles, ...rows].map((row) => ({ sessionId: String(row.session_id), runId: String(row.run_id), text: String(row.text) }));
}

/** Newest first, keyset by event id. A slimmed row matches through its `items` row and is returned whole. */
export function grepEvents(store: ExecutionStore, sessionId: string, needle: string, before: number | undefined, limit: number): Array<{ id: number; value: string }> {
  const like = `%${escapeLike(needle)}%`;
  const matches = `(value LIKE ?1 ESCAPE '\\' OR (json_extract(value,'$.${SLIM_MARKER}') IS NOT NULL AND EXISTS (
    SELECT 1 FROM items WHERE items.session_id=events.session_id AND items.item_id=json_extract(events.value,'$.item.id')
      AND items.value LIKE ?1 ESCAPE '\\')))`;
  const rows = before === undefined
    ? store.statement(`SELECT id, value FROM events WHERE session_id=?2 AND ${matches} ORDER BY id DESC LIMIT ?3`).all(like, sessionId, limit)
    : store.statement(`SELECT id, value FROM events WHERE session_id=?2 AND id<?4 AND ${matches} ORDER BY id DESC LIMIT ?3`).all(like, sessionId, limit, before);
  return rows.map((row) => {
    const value = String(row.value);
    return { id: Number(row.id), value: value.includes(`"${SLIM_MARKER}"`) ? JSON.stringify(rehydrate(store, sessionId, value)) : value };
  });
}

export const ITEMS_ROWS_PREFIX = "items-rows/";

/** Exported so a test can hold the query plan to the `items_run` index. */
export const ITEM_ROWS_FOR_RUNS_SQL =
  "SELECT value FROM items WHERE session_id=? AND run_id IN (SELECT value FROM json_each(?)) ORDER BY ord";

/** Decided by the per-session marker, never by a missing document, which can't tell migrated from empty. */
export function itemsAreRows(store: ExecutionStore, sessionId: string): boolean {
  return store.statement("SELECT 1 FROM metadata WHERE key=? LIMIT 1").get(`${ITEMS_ROWS_PREFIX}${sessionId}`) != null;
}

/** The rows, the deleted blob and the marker commit together, or a kill between them loses the items. */
export function migrateItemsToRows(store: ExecutionStore, sessionId: string, rows: ReadonlyArray<{ id: string; runId: string; value: string }>, documents: string[]): void {
  store.atomically(() => {
    const insert = store.statement("INSERT INTO items(session_id,item_id,run_id,ord,value) VALUES(?,?,?,?,?) "
      + "ON CONFLICT(session_id,item_id) DO UPDATE SET run_id=excluded.run_id, value=excluded.value");
    rows.forEach((row, at) => insert.run(sessionId, row.id, row.runId, at + 1, row.value));
    for (const key of documents) store.statement("DELETE FROM documents WHERE key=?").run(path.relative(store.root, key));
    store.setMetadata(`${ITEMS_ROWS_PREFIX}${sessionId}`, String(rows.length));
  });
}

/** `ord` is assigned on first insert and kept across updates. */
export function upsertItems(store: ExecutionStore, sessionId: string, rows: ReadonlyArray<{ id: string; runId: string; value: string }>): void {
  if (rows.length === 0) return;
  const insert = store.statement("INSERT INTO items(session_id,item_id,run_id,ord,value) "
    + "VALUES(?,?,?,(SELECT COALESCE(MAX(ord),0)+1 FROM items WHERE session_id=?),?) "
    + "ON CONFLICT(session_id,item_id) DO UPDATE SET run_id=excluded.run_id, value=excluded.value");
  for (const row of rows) {
    unslim(store, sessionId, row.id, row.value);
    insert.run(sessionId, row.id, row.runId, sessionId, row.value);
  }
}

export function hasItemRow(store: ExecutionStore, sessionId: string, itemId: string): boolean {
  return store.statement("SELECT 1 FROM items WHERE session_id=? AND item_id=? LIMIT 1").get(sessionId, itemId) != null;
}

export function itemRows(store: ExecutionStore, sessionId: string): string[] {
  return store.statement("SELECT value FROM items WHERE session_id=? ORDER BY ord").all(sessionId).map((row) => String(row.value));
}

/** The run ids ride as JSON so the SQL text, and so the statement cache, stays constant. */
export function itemRowsForRuns(store: ExecutionStore, sessionId: string, runIds: readonly string[]): string[] {
  if (runIds.length === 0) return [];
  return store.statement(ITEM_ROWS_FOR_RUNS_SQL)
    .all(sessionId, JSON.stringify(runIds)).map((row) => String(row.value));
}
