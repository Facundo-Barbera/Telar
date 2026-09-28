import crypto from "node:crypto";
import path from "node:path";
import type { EngineEvent } from "@telar/engine-client";
import type { TurnSummary } from "../../domains/turns";
import { atomicWrite } from "../fs/atomic";
import { statePaths } from "../../state-paths";
import { maybeBarrier } from "./durability";
import {
  COMPACT_WATERMARK_PREFIX, reclaim, rehydrate, pruneReceipts, REQUEST_PRUNE_WATERMARK_PREFIX, SLIM_WATERMARK_PREFIX,
  startSweepWalk, sweep, TERMINAL_HIGH_PREFIX, TERMINAL_TURN_TYPES, USAGE_WATERMARK_PREFIX, vacuumInto, type SweepStep, type SweepTotals,
} from "./journal-maintenance";
import { exportLegacy, fenceLegacy, importLegacy, sweepLegacyBackup } from "./legacy";
import { exportSession, JOURNAL_FLOOR_PREFIX, retentionPreview, retireJournal, retireSession } from "./retention";
import { openDatabase, type Database, type Statement } from "./schema";
import * as tables from "./tables";

/** A delta may sit in memory for this many events or this long; readers see it at once, only durability waits. */
const FLUSH_COUNT = 32;
const FLUSH_AFTER_MS = 200;
/** A receipt only answers a retry within seconds; the prune is a full scan because an index would cost every command. */
const RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const RECEIPT_PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;
const LEGACY_BACKUP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** The first sweep waits until the daemon is answering; on a large store it takes close to a minute. */
const COMPACT_AFTER_OPEN_MS = 5_000;

export type ExecutionHousekeeping = {
  receipts: number;
  backup?: { removed: boolean; bytes: number; files: number; ageMs: number };
  journal?: { deltas: number; starts: number; sessions: number };
  /** `refused` counts sessions whose fold failed its conservation check. */
  usage?: { rows: number; turns: number; sessions: number; refused: number };
  slimmed?: { rows: number; sessions: number };
  requests?: { pairs: number; turns: number; sessions: number; refused: number };
};

/** Only a bench or a test sets these. `now` ages receipts on the wall clock, not the engine's logical clock. */
export type ExecutionStoreOptions = {
  flushCount?: number;
  flushAfterMs?: number;
  now?: () => number;
  receiptRetentionMs?: number;
  legacyBackupRetentionMs?: number;
  onJournalCompacted?: (swept: { deltas: number; starts: number; sessions: number }) => void;
  /** Called once per device barrier actually issued. */
  onDurabilityBarrier?: (at: { sessionId: string; eventId: number }) => void;
  onRetentionSweep?: () => void;
  compactAfterOpenMs?: number;
  /** How the background sweep yields between chunks; an unref'd macrotask by default. */
  sweepYield?: (next: () => void) => void;
};

/** The one execution database. Maintenance, retention, tables and legacy import are free functions over it. */
export class ExecutionStore {
  readonly db: Database;
  readonly searchIndex: "fts5" | "like";
  readonly housekeeping: ExecutionHousekeeping = { receipts: 0 };
  /** The highest id handed out per session; one writer, so memory is authoritative once read. */
  readonly cursors = new Map<string, number>();
  readonly now: () => number;
  readonly receiptRetentionMs: number;
  readonly sweepYield: (next: () => void) => void;
  readonly onJournalCompacted?: (swept: { deltas: number; starts: number; sessions: number }) => void;
  readonly onDurabilityBarrier?: (at: { sessionId: string; eventId: number }) => void;
  readonly onRetentionSweep?: () => void;
  depth = 0;
  closed = false;
  /** The sweep in flight; `close()` cancels it through this handle. */
  walk?: { cancelled: boolean };
  pruneMode?: { sessionId: string; at: number; mode: string | undefined };
  /** The terminal turn event this write scope appended; cleared by a rollback. */
  barrierDue?: { sessionId: string; eventId: number };
  private readonly statements = new Map<string, Statement>();
  // `buffered` is committed, `pending` belongs to the open transaction, and `writtenAhead` is the part of
  // `buffered` that transaction already inserted. Only `content.delta` is held; everything else writes behind it.
  private buffered: EngineEvent[] = [];
  private pending: EngineEvent[] = [];
  private writtenAhead: EngineEvent[] = [];
  private flushTimer?: ReturnType<typeof setTimeout>;
  private bufferedSince = 0;
  private readonly flushCount: number;
  private readonly flushAfterMs: number;
  private pruneTimer?: ReturnType<typeof setInterval>;
  private compactTimer?: ReturnType<typeof setTimeout>;

  constructor(readonly root: string, options: ExecutionStoreOptions = {}) {
    this.flushCount = Math.max(1, options.flushCount ?? FLUSH_COUNT);
    this.flushAfterMs = Math.max(0, options.flushAfterMs ?? FLUSH_AFTER_MS);
    this.now = options.now ?? Date.now;
    this.receiptRetentionMs = Math.max(0, options.receiptRetentionMs ?? RECEIPT_RETENTION_MS);
    if (options.onJournalCompacted) this.onJournalCompacted = options.onJournalCompacted;
    if (options.onDurabilityBarrier) this.onDurabilityBarrier = options.onDurabilityBarrier;
    if (options.onRetentionSweep) this.onRetentionSweep = options.onRetentionSweep;
    this.sweepYield = options.sweepYield ?? ((next) => { setImmediate(next).unref?.(); });
    ({ db: this.db, searchIndex: this.searchIndex } = openDatabase(root));
    try {
      if (!this.db.prepare("SELECT value FROM metadata WHERE key='imported'").get()) importLegacy(this);
      atomicWrite(statePaths(root).executionStore, { version: 1, backend: "sqlite" });
      for (const sessionId of this.sessionIds()) fenceLegacy(root, sessionId);
      this.housekeeping.receipts = this.pruneReceipts();
      const backup = sweepLegacyBackup(this, Math.max(0, options.legacyBackupRetentionMs ?? LEGACY_BACKUP_RETENTION_MS));
      if (backup) this.housekeeping.backup = backup;
    } catch (error) { this.db.close(); throw error; }
    // Armed after the constructor can no longer throw. Housekeeping is never why a process stays up.
    this.pruneTimer = setInterval(() => {
      if (this.closed) return;
      try { this.pruneReceipts(); } catch {}
      this.sweepJournal();
    }, RECEIPT_PRUNE_EVERY_MS);
    this.pruneTimer.unref?.();
    this.compactTimer = setTimeout(() => { this.sweepJournal(); }, options.compactAfterOpenMs ?? COMPACT_AFTER_OPEN_MS);
    this.compactTimer.unref?.();
  }

  /** Every statement is compiled once, keyed by its literal SQL. */
  statement(sql: string): Statement {
    let cached = this.statements.get(sql);
    if (!cached) {
      cached = this.db.prepare(sql);
      this.statements.set(sql, cached);
    }
    return cached;
  }

  setMetadata(key: string, value: string): void {
    this.statement("INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }

  private sweepJournal(): void { startSweepWalk(this); }
  sweep(steps?: readonly SweepStep[]): SweepTotals { return sweep(this, steps); }
  pruneReceipts(): number { return pruneReceipts(this); }
  reclaim() { return reclaim(this); }
  vacuumInto(file: string): void { vacuumInto(this, file); }
  retentionPreview(window: { idleBefore: number; now: number }, options?: { bytes?: boolean }) { return retentionPreview(this, window, options); }
  exportSession(sessionId: string, destination: string) { return exportSession(this, sessionId, destination); }
  retireSession(sessionId: string, options: { exportTo: string }) { return retireSession(this, sessionId, options); }
  retireJournal(window: { idleBefore: number; now: number }, options: { exportTo: string }) { return retireJournal(this, window, options); }
  exportLegacy(destination: string): void { exportLegacy(this, destination); }

  owns(file: string): boolean {
    const key = path.relative(this.root, file);
    return key === "task-stops.json" || key === "subscriptions.json"
      || /^sessions\/[A-Za-z0-9_-]+\/(session|queue|items|requests|tasks)\.json$/.test(key)
      // Offset indexes commit with their document.
      || /^sessions\/[A-Za-z0-9_-]+\/(queue|items)\.index\.json$/.test(key);
  }
  read(file: string): unknown {
    const row = this.statement("SELECT value FROM documents WHERE key=?").get(path.relative(this.root, file));
    return row ? JSON.parse(String(row.value)) : undefined;
  }
  write(file: string, value: unknown): void {
    this.writeText(file, JSON.stringify(value));
  }
  writeText(file: string, text: string): void {
    this.statement("INSERT INTO documents(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(path.relative(this.root, file), text);
    if (path.basename(file) === "session.json") fenceLegacy(this.root, path.basename(path.dirname(file)));
  }
  /** Bytes, not characters: `CAST(value AS BLOB)` makes `length` and `substr` count what the index records. */
  byteLength(file: string): number | undefined {
    const row = this.statement("SELECT length(CAST(value AS BLOB)) AS size FROM documents WHERE key=?").get(path.relative(this.root, file));
    return row ? Number(row.size) : undefined;
  }
  slice(file: string, start: number, end: number): Buffer | undefined {
    if (end <= start) return Buffer.alloc(0);
    const row = this.statement("SELECT substr(CAST(value AS BLOB),?,?) AS span FROM documents WHERE key=?")
      .get(start + 1, end - start, path.relative(this.root, file));
    if (!row) return undefined;
    const span = row.span;
    return Buffer.isBuffer(span) ? span : Buffer.from(span as Uint8Array);
  }

  itemsAreRows(sessionId: string): boolean { return tables.itemsAreRows(this, sessionId); }
  migrateItemsToRows(sessionId: string, rows: ReadonlyArray<{ id: string; runId: string; value: string }>, documents: string[]): void { tables.migrateItemsToRows(this, sessionId, rows, documents); }
  upsertItems(sessionId: string, rows: ReadonlyArray<{ id: string; runId: string; value: string }>): void { tables.upsertItems(this, sessionId, rows); }
  hasItemRow(sessionId: string, itemId: string): boolean { return tables.hasItemRow(this, sessionId, itemId); }
  itemRows(sessionId: string): string[] { return tables.itemRows(this, sessionId); }
  itemRowsForRuns(sessionId: string, runIds: readonly string[]): string[] { return tables.itemRowsForRuns(this, sessionId, runIds); }
  sessionIds(): string[] { return tables.sessionIds(this); }
  sessionRowGaps() { return tables.sessionRowGaps(this); }
  liveSessionRows(): tables.SessionIndexRow[] { return tables.liveSessionRows(this); }
  dueSnoozeWakes(): tables.SessionIndexRow[] { return tables.dueSnoozeWakes(this); }
  sessionRow(sessionId: string): tables.SessionIndexRow | undefined { return tables.sessionRow(this, sessionId); }
  projectSessionRows(projectId: string): tables.SessionIndexRow[] { return tables.projectSessionRows(this, projectId); }
  projectActivity() { return tables.projectActivity(this); }
  writeSessionRow(row: tables.SessionIndexRow): void { tables.writeSessionRow(this, row); }
  deleteSessionRow(sessionId: string): void { tables.deleteSessionRow(this, sessionId); }
  dueSchedules(now: number): tables.ScheduleRow[] { return tables.dueSchedules(this, now); }
  listSchedules(sessionId?: string): tables.ScheduleRow[] { return tables.listSchedules(this, sessionId); }
  readSchedule(id: string): tables.ScheduleRow | undefined { return tables.readSchedule(this, id); }
  writeSchedule(row: tables.ScheduleRow): void { tables.writeSchedule(this, row); }
  deleteSchedule(id: string): boolean { return tables.deleteSchedule(this, id); }
  turnSummaryStates(sessionId: string) { return tables.turnSummaryStates(this, sessionId); }
  writeTurnSummary(row: TurnSummary): void { tables.writeTurnSummary(this, row); }
  deleteTurnSummary(sessionId: string, runId: string): void { tables.deleteTurnSummary(this, sessionId, runId); }
  outlineRows(sessionId: string, before: number | undefined, limit: number): TurnSummary[] { return tables.outlineRows(this, sessionId, before, limit); }
  turnSummary(sessionId: string, runId: string): TurnSummary | undefined { return tables.turnSummary(this, sessionId, runId); }
  latestAnsweredTurn(sessionId: string): TurnSummary | undefined { return tables.latestAnsweredTurn(this, sessionId); }
  turnSummaryCount(sessionId: string): number { return tables.turnSummaryCount(this, sessionId); }
  turnSummaryGaps(): string[] { return tables.turnSummaryGaps(this); }
  searchTurnText(terms: string[], scan: number) { return tables.searchTurnText(this, terms, scan); }
  grepEvents(sessionId: string, needle: string, before: number | undefined, limit: number) { return tables.grepEvents(this, sessionId, needle, before, limit); }

  /** `(after, ...]` in id order, with `limit` pushed into sqlite. Held deltas are newer than every stored row, so they come last. */
  events(sessionId: string, after = 0, limit?: number): EngineEvent[] {
    const bounded = limit !== undefined && Number.isSafeInteger(limit) && limit > 0;
    const stored = (bounded
      ? this.statement("SELECT value FROM events WHERE session_id=? AND id>? ORDER BY id LIMIT ?").all(sessionId, after, limit)
      : this.statement("SELECT value FROM events WHERE session_id=? AND id>? ORDER BY id").all(sessionId, after)
    ).map((row) => rehydrate(this, sessionId, String(row.value)));
    if (bounded && stored.length >= limit!) return stored;
    const held = this.held().filter((event) => event.sessionId === sessionId && event.id > after);
    if (!held.length) return stored;
    const page = [...stored, ...held];
    return bounded ? page.slice(0, limit) : page;
  }
  cursor(sessionId: string): number {
    const known = this.cursors.get(sessionId);
    if (known !== undefined) return known;
    const rows = Number(this.statement("SELECT COALESCE(MAX(id),0) AS id FROM events WHERE session_id=?").get(sessionId)?.id ?? 0);
    const floor = Number(this.statement("SELECT value FROM metadata WHERE key=?").get(`${JOURNAL_FLOOR_PREFIX}${sessionId}`)?.value ?? 0);
    const stored = Math.max(rows, Number.isFinite(floor) ? floor : 0);
    const head = this.held().reduce((highest, event) => event.sessionId === sessionId && event.id > highest ? event.id : highest, stored);
    this.cursors.set(sessionId, head);
    return head;
  }
  append(event: EngineEvent): void {
    this.cursors.set(event.sessionId, Math.max(event.id, this.cursors.get(event.sessionId) ?? 0));
    const terminal = (TERMINAL_TURN_TYPES as readonly string[]).includes(event.type);
    if (terminal) this.barrierDue = { sessionId: event.sessionId, eventId: event.id };
    if (event.type !== "content.delta") {
      // Written behind every held delta, in one transaction, so ids on disk stay contiguous.
      this.atomically(() => {
        this.drain(this.depth > 0);
        this.insert(event);
        if (terminal) this.setMetadata(`${TERMINAL_HIGH_PREFIX}${event.sessionId}`, String(event.id));
      });
      return;
    }
    (this.depth > 0 ? this.pending : this.buffered).push(event);
    if (this.bufferedSince === 0) this.bufferedSince = Date.now();
    if (this.buffered.length + this.pending.length >= this.flushCount) this.flush();
    else this.arm();
  }

  deleteSession(sessionId: string): void {
    this.atomically(() => {
      // Stored first, so the DELETE decides they are gone and a rollback restores the whole session.
      this.drain(this.depth > 0);
      const [low, high] = tables.prefixRange(`sessions/${sessionId}/`);
      this.statement("DELETE FROM documents WHERE key >= ? AND key < ?").run(low, high);
      this.statement("DELETE FROM events WHERE session_id=?").run(sessionId);
      tables.deleteSessionRow(this, sessionId);
      this.statement("DELETE FROM items WHERE session_id=?").run(sessionId);
      for (const prefix of [
        COMPACT_WATERMARK_PREFIX, USAGE_WATERMARK_PREFIX, SLIM_WATERMARK_PREFIX, REQUEST_PRUNE_WATERMARK_PREFIX,
        TERMINAL_HIGH_PREFIX, tables.ITEMS_ROWS_PREFIX, JOURNAL_FLOOR_PREFIX,
      ]) this.statement("DELETE FROM metadata WHERE key=?").run(`${prefix}${sessionId}`);
      this.cursors.delete(sessionId);
    });
  }

  /** Every delta accepted and not yet stored. */
  held(): EngineEvent[] {
    return this.buffered.length || this.pending.length ? [...this.buffered, ...this.pending] : [];
  }
  private insert(event: EngineEvent): void {
    this.statement("INSERT INTO events(session_id,id,value) VALUES(?,?,?)").run(event.sessionId, event.id, JSON.stringify(event));
  }
  /** Stores everything held in the open write scope. `track` records what a rollback must hand back. */
  drain(track: boolean): void {
    if (!this.buffered.length && !this.pending.length) return;
    for (const event of this.buffered) { this.insert(event); if (track) this.writtenAhead.push(event); }
    for (const event of this.pending) this.insert(event);
    this.buffered = [];
    this.pending = [];
    this.disarm();
  }
  /** One transaction without a receipt, or inline when one is already open. */
  atomically(work: () => void): void {
    if (this.depth > 0) return work();
    const settled = this.buffered;
    this.db.exec("BEGIN IMMEDIATE");
    this.depth += 1;
    try { work(); this.db.exec("COMMIT"); }
    catch (error) {
      this.db.exec("ROLLBACK");
      this.buffered.unshift(...settled.filter((event) => !this.buffered.includes(event)));
      this.cursors.clear();
      this.barrierDue = undefined;
      throw error;
    } finally { this.depth -= 1; }
    maybeBarrier(this);
  }
  flush(): void {
    if (this.depth > 0) return this.drain(true);
    if (!this.buffered.length) return;
    this.atomically(() => this.drain(false));
  }
  private arm(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      if (this.closed) return;
      try { this.flush(); } catch { this.arm(); }
    }, Math.max(0, this.flushAfterMs - (Date.now() - this.bufferedSince)));
    this.flushTimer.unref?.();
  }
  private disarm(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = undefined; }
    this.bufferedSince = 0;
  }
  transaction<T>(command: string, operation: () => T, commandId?: string): T {
    if (this.depth > 0) return operation();
    // Deltas settled by an earlier commit are stored on their own, not taken back by this one's rollback.
    if (this.buffered.length && Date.now() - this.bufferedSince >= this.flushAfterMs) this.flush();
    const receiptId = commandId ?? crypto.randomUUID();
    const changesBefore = Number(this.statement("SELECT total_changes() AS count").get()?.count ?? 0);
    this.db.exec("BEGIN IMMEDIATE");
    this.depth += 1;
    let settled!: T;
    try {
      const known = commandId === undefined ? undefined : this.statement("SELECT command,result FROM receipts WHERE id=?").get(receiptId);
      if (known) {
        if (known.command !== command) throw new Error("command id was already used for a different command");
        this.db.exec("COMMIT");
        return JSON.parse(String(known.result)).value as T;
      }
      const result = operation();
      if (result && typeof (result as { then?: unknown }).then === "function") throw new Error("execution transactions must be synchronous");
      const changed = Number(this.statement("SELECT total_changes() AS count").get()?.count ?? 0) !== changesBefore;
      if (commandId !== undefined || changed)
        // Internal receipts are audit markers: never retain a resolved claim's provider secrets.
        this.statement("INSERT INTO receipts(id,command,result,at) VALUES(?,?,?,?)").run(receiptId, command,
          JSON.stringify(commandId === undefined ? {} : { value: result }), this.now());
      this.db.exec("COMMIT");
      this.settle();
      settled = result;
    } catch (error) { this.db.exec("ROLLBACK"); this.revert(); throw error; }
    finally { this.depth -= 1; }
    // Outside the transaction, which sqlite requires, and before the return, so the reply follows the barrier.
    maybeBarrier(this);
    return settled;
  }
  private settle(): void {
    if (this.pending.length) {
      this.buffered.push(...this.pending);
      this.pending = [];
      if (this.bufferedSince === 0) this.bufferedSince = Date.now();
      this.arm();
    }
    this.writtenAhead = [];
  }
  private revert(): void {
    this.pending = [];
    this.barrierDue = undefined;
    if (this.writtenAhead.length) {
      this.buffered.unshift(...this.writtenAhead);
      this.writtenAhead = [];
      this.arm();
    }
    this.cursors.clear();
  }
  close(): void {
    if (this.closed) return;
    this.disarm();
    if (this.pruneTimer) { clearInterval(this.pruneTimer); this.pruneTimer = undefined; }
    if (this.compactTimer) { clearTimeout(this.compactTimer); this.compactTimer = undefined; }
    if (this.walk) { this.walk.cancelled = true; this.walk = undefined; }
    // An orderly shutdown stores the tail. Only a crash may lose it.
    try { this.flush(); } finally { this.statements.clear(); this.cursors.clear(); this.db.close(); this.closed = true; }
  }
}
