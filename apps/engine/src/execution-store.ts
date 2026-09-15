import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { EngineEvent } from "@telar/engine-client";
import { atomicWrite } from "./atomic";
import type { TurnSummary } from "./turn-summary";

type Statement = { run(...args: unknown[]): unknown; get(...args: unknown[]): Record<string, unknown> | undefined; all(...args: unknown[]): Array<Record<string, unknown>> };
type Database = { exec(sql: string): void; prepare(sql: string): Statement; close(): void };
const FILES = new Set(["session.json", "queue.json", "items.json", "requests.json", "tasks.json"]);

/**
 * HOW LONG A STREAMED DELTA MAY SIT IN MEMORY, and how many may sit there.
 *
 * A WAL fsync costs one transaction, and the engine used to run one transaction
 * per `ingestObservations` call — so a driver reporting one delta at a time
 * bought one fsync per token-chunk. Measured on the dogfood Mac: 0.116 ms for a
 * single append, 0.025 ms each at sixteen per transaction. The fsync is the
 * whole cost and the batch size is the only lever on it.
 *
 * THE COUNT IS THE LEVER; THE AGE IS THE BOUND. A streaming turn peaks at 133
 * deltas/s (docs/investigations/performance-2026-09-11.md), so a 16 ms window
 * would hold two chunks and save almost nothing — the investigation's own
 * suggested window cannot reach the number it asks for. 200 ms holds about
 * twenty-six, which is where the per-event cost lands under 0.010 ms.
 *
 * NOTHING WAITS ON THIS. `events` and `cursor` read the buffer, so a subscriber
 * tailing the journal sees a buffered delta exactly as soon as it saw an
 * inserted one; the delay is durability's alone. A crash loses at most this
 * much unwritten tail, which is the trade the investigation names: unflushed
 * deltas may be lost, a settled turn may not.
 */
const FLUSH_COUNT = 32;
const FLUSH_AFTER_MS = 200;

/**
 * HOW LONG A COMMAND RECEIPT IS WORTH KEEPING, and how often the old ones go.
 *
 * A receipt answers one question — "did this exact command id already run?" —
 * and it is asked within the seconds a client spends retrying a request whose
 * response it lost. Nothing reads one afterwards: `transaction` looks a receipt
 * up only when a caller supplies a `commandId`, and the internal ones written
 * as audit markers are never read by anything at all.
 *
 * Kept anyway, they are most of the store. Measured on the dogfood home (#457):
 * 299,323 receipts in a 723 MB `execution.sqlite`, none of them reachable, all
 * of them paid for on every page the streaming path walks. A week is far longer
 * than any retry window and short enough that the table stays small.
 *
 * THE SWEEP IS A FULL SCAN, DELIBERATELY. An index on `at` would be maintained
 * on every command the engine runs, all day, to speed up a DELETE that runs
 * twice a day; the scan is the cheaper side of that trade by orders of
 * magnitude.
 */
const RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const RECEIPT_PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * HOW LONG THE JSON THE IMPORT REPLACED IS KEPT — issue #457.
 *
 * `importLegacy` copies every document it reads into `execution-json-backup`
 * before sqlite becomes the source of truth. That copy is an UNDO for a
 * migration that went wrong, and its whole value is in the days right after it:
 * a store that has been read and written through sqlite for a week has diverged
 * from that copy completely, so restoring it would not recover the work — it
 * would discard it. Measured on the dogfood home: 239 MB still sitting there
 * months later, on a machine with a 735 MB database beside it.
 *
 * THE SAME WEEK THE RECEIPTS GET, and for a related reason: a week is far
 * longer than anyone takes to notice a migration failed, and short enough that
 * the copy does not become permanent.
 */
const LEGACY_BACKUP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * THE SCALARS THE RAIL DECIDES ON, PROMOTED OUT OF `session.json` — issue #493.
 *
 * Every field here is one the live fold READS TO DECIDE something: which rows
 * are on the list (`isShelved`, which wants `state`, `settledOverride`, the
 * snooze pair, the unread pair, `readAt`, `draft` and the activity), and in what
 * order (`updatedAt`, then `id`). Nothing here is payload — a title, a
 * workspace, a usage snapshot are read from the document, and only for the rows
 * that survive the decision.
 *
 * THAT SPLIT IS THE WHOLE POINT. On the owner's store the fold had to parse 291
 * `session.json` blobs and 291 `queue.json` blobs — 48 MB — to discover that 284
 * of them were settled and would not be sent. These rows are ~120 bytes each:
 * the same decision costs 37 KB and no JSON parsing at all.
 *
 * `activity` IS DERIVED AND STORED ANYWAY. It is a fold over the queue, the open
 * requests and the live tasks — three documents — and it is both a decision
 * input (`settlingActivityOf`) and a field the wire carries. Storing the fold
 * rather than its three inputs is what lets a shelving decision touch no
 * document at all; it is recomputed on every write that could move it, in that
 * write's own transaction, so it cannot drift.
 */
export type SessionIndexRow = {
  id: string;
  projectId?: string;
  state: "active" | "archived";
  updatedAt: number;
  createdAt: number;
  /** `state === "archived"`, as the boolean the settling rule reads. Stored
   *  rather than derived in SQL because it is the leading column of the index
   *  the ordered read seeks on. */
  archived: boolean;
  /** The PRESENCE of a draft record, which is all the rule asks about. */
  draft: boolean;
  readAt?: number;
  settledOverride?: "settled" | "active";
  settledAt?: number;
  snoozedUntil?: number;
  snoozedAt?: number;
  lastTurnSequence?: number;
  lastReadTurnSequence?: number;
  lastTurnEndedAt?: number;
  lastTurnFailed?: boolean;
  activity: "idle" | "blocked" | "working" | "queued" | "monitoring";
  activityAt?: number;
  /**
   * WHAT THIS CONVERSATION IS CALLED, AND THE BRANCH IT CUT — issue #516.
   *
   * The two exceptions to "nothing here is payload", and they earn it the same
   * way `activity` does: `find` DECIDES on them. A search that had to open 300
   * `session.json` blobs to learn which ones are called something would be the
   * fold #493 removed, reinstated by a different caller.
   *
   * Read by `find` alone. Nothing on the rail's wire is built from them.
   */
  title?: string;
  branch?: string;
};

/** A stored row is columns; `undefined` and `null` are the same absence here. */
type StoredSessionRow = Record<string, unknown>;

function rowFromColumns(columns: StoredSessionRow): SessionIndexRow {
  const state = String(columns.state) === "archived" ? "archived" : "active";
  const override = columns.settled_override === null || columns.settled_override === undefined
    ? undefined
    : String(columns.settled_override) === "settled" ? "settled" as const : "active" as const;
  return {
    id: String(columns.id),
    ...(columns.project_id === null || columns.project_id === undefined ? {} : { projectId: String(columns.project_id) }),
    state,
    updatedAt: Number(columns.updated_at),
    createdAt: Number(columns.created_at),
    archived: Number(columns.archived) === 1,
    draft: Number(columns.draft) === 1,
    ...(columns.read_at === null || columns.read_at === undefined ? {} : { readAt: Number(columns.read_at) }),
    ...(override === undefined ? {} : { settledOverride: override }),
    ...(columns.settled_at === null || columns.settled_at === undefined ? {} : { settledAt: Number(columns.settled_at) }),
    ...(columns.snoozed_until === null || columns.snoozed_until === undefined ? {} : { snoozedUntil: Number(columns.snoozed_until) }),
    ...(columns.snoozed_at === null || columns.snoozed_at === undefined ? {} : { snoozedAt: Number(columns.snoozed_at) }),
    ...(columns.last_turn_sequence === null || columns.last_turn_sequence === undefined ? {} : { lastTurnSequence: Number(columns.last_turn_sequence) }),
    ...(columns.last_read_turn_sequence === null || columns.last_read_turn_sequence === undefined ? {} : { lastReadTurnSequence: Number(columns.last_read_turn_sequence) }),
    ...(columns.last_turn_ended_at === null || columns.last_turn_ended_at === undefined ? {} : { lastTurnEndedAt: Number(columns.last_turn_ended_at) }),
    ...(Number(columns.last_turn_failed) === 1 ? { lastTurnFailed: true } : {}),
    activity: String(columns.activity) as SessionIndexRow["activity"],
    ...(columns.activity_at === null || columns.activity_at === undefined ? {} : { activityAt: Number(columns.activity_at) }),
    ...(columns.title === null || columns.title === undefined ? {} : { title: String(columns.title) }),
    ...(columns.branch === null || columns.branch === undefined ? {} : { branch: String(columns.branch) }),
  };
}

/** One turn's row, back from its columns — issue #516. `item_titles` is stored
 *  as JSON because it is a bounded list nothing queries INTO; a row that could
 *  not parse is an empty list rather than a throw, on the same argument
 *  `rowFromColumns` makes about a corrupt directory. */
function turnFromColumns(columns: StoredSessionRow): TurnSummary {
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
    ...(columns.started_at === null || columns.started_at === undefined ? {} : { startedAt: Number(columns.started_at) }),
    ...(columns.ended_at === null || columns.ended_at === undefined ? {} : { endedAt: Number(columns.ended_at) }),
    input: String(columns.input_line ?? ""),
    itemCount: Number(columns.item_count ?? 0),
    itemTitles: titles,
    answerHead: String(columns.answer_head ?? ""),
    answerChars: Number(columns.answer_chars ?? 0),
    ...(columns.failure_text === null || columns.failure_text === undefined ? {} : { failure: String(columns.failure_text) }),
  };
}

/** `%` and `_` are wildcards in `LIKE`, and a person searching for `index.lock`
 *  or a snake_case symbol did not mean them as such. Paired with `ESCAPE '\'`
 *  at every call site. */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** What the housekeeping on open actually removed, so the daemon can say so and
 *  a test can hold it to it. Nothing here is otherwise observable. */
export type ExecutionHousekeeping = {
  /** Command receipts swept past their retention. */
  receipts: number;
  /** The migration backup, when there was one to consider. `removed: false`
   *  means it is still inside its week. */
  backup?: { removed: boolean; bytes: number; files: number; ageMs: number };
};

/** What a directory holds, in bytes and files — so a deletion can say what it
 *  took. Tolerant by design: a tree being swept is a tree nothing else should
 *  be touching, and an unreadable corner of it must not stop the sweep. */
function directorySize(directory: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return { bytes, files };
  }
  for (const entry of entries) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const inner = directorySize(child);
      bytes += inner.bytes;
      files += inner.files;
    } else {
      try {
        bytes += fs.statSync(child).size;
        files += 1;
      } catch { /* vanished under us; it is not there to delete either */ }
    }
  }
  return { bytes, files };
}

/**
 * THE HALF-OPEN RANGE THAT MATCHES A KEY PREFIX — `[prefix, prefix+1)`.
 *
 * `documents.key` is the table's PRIMARY KEY, so a comparison against a
 * constant is an index seek and a `LIKE` is not: SQLite's `LIKE` is
 * case-insensitive over ASCII by default, which makes it unusable as an index
 * constraint, and `substr(key,1,?)=?` is a function of the column, which is
 * worse — it has to compute the left side for every row in the table before it
 * can compare anything. Measured on the owner's store (#493), both were full
 * scans of 305 rows holding 48 MB of conversation text, one per call.
 *
 * THE UPPER BOUND IS THE PREFIX WITH ITS LAST CHARACTER INCREMENTED, which is
 * why every caller here passes a prefix ending in `/` (0x2F): the bound is the
 * same string ending in `0` (0x30), and no key that starts with the prefix can
 * sort at or above it. Spelled as a function rather than inline so the two call
 * sites cannot disagree about it.
 */
function prefixRange(prefix: string): [string, string] {
  const last = prefix.charCodeAt(prefix.length - 1);
  return [prefix, `${prefix.slice(0, -1)}${String.fromCharCode(last + 1)}`];
}

/** Only a bench or a test sets these; production runs the constants above.
 *  `flushCount: 1` is the behaviour before coalescing — every delta written
 *  where it was appended — which is what makes the two comparable.
 *
 *  `now` IS WALL-CLOCK HOUSEKEEPING, NOT THE ENGINE'S LOGICAL CLOCK. A receipt's
 *  age decides when it is swept and nothing else; a store driven by a test's
 *  counting clock must not age its receipts in ticks. */
export type ExecutionStoreOptions = {
  flushCount?: number;
  flushAfterMs?: number;
  now?: () => number;
  receiptRetentionMs?: number;
  legacyBackupRetentionMs?: number;
};

/** One authoritative execution database; legacy files become a migration backup.
 * Runtime adapters use the built-in SQLite API of Bun and Node/Electron.
 */
export class ExecutionStore {
  private readonly db: Database;
  private depth = 0;
  private closed = false;
  /**
   * EVERY STATEMENT COMPILED ONCE, KEYED BY ITS OWN SQL.
   *
   * These are a fixed set of literals — there is no user input in any of them,
   * and no path where the text varies — so the cache is bounded by the number
   * of call sites rather than by anything a caller can grow. Preparing is not
   * free: sqlite reparses and replans the statement each time, and with the
   * worker beating ten times a second `prepare` was 8% of the engine's idle
   * CPU on its own, entirely to recompile the same seven queries.
   *
   * Both runtimes finalize whatever they still hold when the database closes,
   * so the cache needs no teardown beyond dropping its references.
   */
  private readonly statements = new Map<string, Statement>();

  private statement(sql: string): Statement {
    let cached = this.statements.get(sql);
    if (!cached) {
      cached = this.db.prepare(sql);
      this.statements.set(sql, cached);
    }
    return cached;
  }

  /**
   * THE DELTAS THAT ARE JOURNALLED BUT NOT YET ON DISK.
   *
   * `buffered` is settled: the transaction that appended them committed, and
   * every reader below already answers with them. `pending` was appended inside
   * the transaction still open, so it is discarded if that transaction rolls
   * back. `writtenAhead` is the part of `buffered` an open transaction has
   * already inserted — it goes back into `buffered` on a rollback, because
   * those deltas were committed by an EARLIER transaction and a later failure
   * is not allowed to take them.
   *
   * Only `content.delta` is ever held. Everything else writes through, and
   * writes through BEHIND whatever is buffered: a settled `item.completed` that
   * reached the disk ahead of the deltas it concludes would leave a hole in the
   * id sequence if the process died between them, and the journal's ids have to
   * stay contiguous.
   */
  private buffered: EngineEvent[] = [];
  private pending: EngineEvent[] = [];
  private writtenAhead: EngineEvent[] = [];
  private flushTimer?: ReturnType<typeof setTimeout>;
  private bufferedSince = 0;
  /** The highest id handed out per session — `MAX(id)` once, then memory.
   *  One writer holds the daemon lock, so nothing else can move it. */
  private readonly cursors = new Map<string, number>();
  private readonly flushCount: number;
  private readonly flushAfterMs: number;
  private readonly now: () => number;
  private readonly receiptRetentionMs: number;
  private readonly legacyBackupRetentionMs: number;
  private pruneTimer?: ReturnType<typeof setInterval>;
  /**
   * WHAT THE HOUSEKEEPING ON OPEN REMOVED — issue #457, step 4.
   *
   * Read by the daemon, which says it out loud. Both sweeps delete things
   * nothing can reach, so without a line in the log the only evidence a person
   * has that 239 MB went away is that it is gone.
   */
  readonly housekeeping: ExecutionHousekeeping = { receipts: 0 };
  /**
   * WHICH ENGINE `find` RUNS ON — probed, never assumed (issue #516).
   *
   * FTS5 is a compile-time option, and this store runs on two different sqlite
   * builds: `bun:sqlite` (which has it) and `node:sqlite` (which may not, and
   * which the worker process uses). A hard dependency on it would make a search
   * route that works in the daemon throw in a test runner — so the virtual table
   * is attempted, and a store that cannot have it says `like` and falls back to a
   * bounded scan of the same rows. No new dependency either way, which is the
   * constraint the issue set.
   */
  readonly searchIndex: "fts5" | "like" = "like";
  constructor(readonly root: string, options: ExecutionStoreOptions = {}) {
    this.flushCount = Math.max(1, options.flushCount ?? FLUSH_COUNT);
    this.flushAfterMs = Math.max(0, options.flushAfterMs ?? FLUSH_AFTER_MS);
    this.now = options.now ?? Date.now;
    this.receiptRetentionMs = Math.max(0, options.receiptRetentionMs ?? RECEIPT_RETENTION_MS);
    this.legacyBackupRetentionMs = Math.max(0, options.legacyBackupRetentionMs ?? LEGACY_BACKUP_RETENTION_MS);
    const native = createRequire(import.meta.url)(process.versions.bun ? "bun:sqlite" : "node:sqlite");
    const file = path.join(root, "execution.sqlite");
    this.db = process.versions.bun ? new native.Database(file) : new native.DatabaseSync(file);
    try {
    fs.chmodSync(file, 0o600);
    /**
     * `synchronous=NORMAL`, NOT `FULL` — WAL IS WHAT MAKES THAT SAFE.
     *
     * In WAL mode NORMAL still writes every committed transaction to the WAL; it
     * only stops fsyncing the WAL at each commit. A PROCESS crash — the engine
     * throwing, being killed, the daemon restarting — loses nothing at all,
     * because the committed bytes are already in the file and recovery replays
     * them. What NORMAL gives up is the POWER-LOSS case: an OS crash or a pulled
     * plug may lose the last transaction or two that the kernel had not yet
     * flushed. FULL bought that one guarantee at one fsync per transaction, and
     * fsync was the engine's largest single cost while an agent typed (#443).
     *
     * The trade is the same one the delta buffer above already makes, one layer
     * down: the tail of a conversation may not survive the machine losing power.
     * A checkpoint still fsyncs, so the database file itself is never at risk.
     */
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;");
    const version = Number(this.db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
    if (version > 1) throw new Error("execution database requires a newer Telar version");
    this.db.exec(`CREATE TABLE IF NOT EXISTS documents (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (session_id TEXT NOT NULL, id INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(session_id,id));
      CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, command TEXT NOT NULL, result TEXT NOT NULL, at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA user_version=1;`);
    /**
     * THE RAIL'S DECISION COLUMNS — issue #493. See `SessionIndexRow`.
     *
     * ADDITIVE, AND `user_version` STAYS AT 1, for the reason the receipts
     * column below gives: an older binary neither reads nor writes this table,
     * and a store it has written is one whose rows are stale. That is why
     * `reconcileSessionRows` runs on EVERY open rather than once — the marker it
     * would otherwise trust cannot survive a downgrade, and a stale row is a
     * conversation missing from somebody's sidebar.
     *
     * TWO INDEXES, BOTH FOR AN ORDERED READ. `(archived, settled_override,
     * updated_at)` is the live fold's: it seeks past the archived rows and hands
     * back the rest already in `updatedAt` order, which is the order the answer
     * is in. `(project_id, updated_at)` is `listSessions`'s, which is the same
     * shape one project at a time.
     */
    this.db.exec(`CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        state TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        draft INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0,
        read_at INTEGER,
        settled_override TEXT,
        settled_at INTEGER,
        snoozed_until INTEGER,
        snoozed_at INTEGER,
        last_turn_sequence INTEGER,
        last_read_turn_sequence INTEGER,
        last_turn_ended_at INTEGER,
        last_turn_failed INTEGER NOT NULL DEFAULT 0,
        activity TEXT NOT NULL DEFAULT 'idle',
        activity_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS sessions_shelf ON sessions(archived, settled_override, updated_at);
      CREATE INDEX IF NOT EXISTS sessions_project ON sessions(project_id, updated_at);`);
    /**
     * WHAT A SESSION IS CALLED, AND WHERE IT WORKS — issue #516.
     *
     * ADDITIVE COLUMNS ON THE #493 TABLE rather than a table of their own,
     * because they answer the same question that one does — which conversation
     * is this — and because `find` has to match a title without opening a
     * document. Nullable and defaulted, so an older binary neither knows nor
     * needs to know they exist; the reconcile on open fills them, exactly as it
     * fills a row a downgrade left behind.
     *
     * NOT ON THE WIRE. `liveSessionRows` builds its rows from Session records,
     * not from these, so nothing here grows the rail's answer — which is the one
     * thing #493 bought and this must not spend.
     */
    for (const column of ["title TEXT", "branch TEXT"]) {
      const name = column.split(" ")[0]!;
      if (!this.db.prepare("PRAGMA table_info(sessions)").all().some((existing) => String(existing.name) === name))
        this.db.exec(`ALTER TABLE sessions ADD COLUMN ${column}`);
    }
    /**
     * ONE ROW PER TURN, WRITTEN WHEN THE TURN ENDS — issue #516. See
     * `turn-summary.ts` for what a row holds and why each bound is where it is.
     *
     * KEYED BY (session, run) AND ORDERED BY SEQUENCE, which is the shape every
     * reader has: an outline is this session's rows newest first, `answer` is one
     * row by its run id, and `find` is a match across all of them. `sequence` is
     * the queue's own append order, so paging by it needs no timestamp tie-break
     * and no second index.
     *
     * ADDITIVE, `user_version` STAYS AT 1, AND THE RECONCILE IS THE PRICE — the
     * same trade the sessions table made. An older binary can settle turns this
     * table never hears about; `turnSummaryStates` is how the next open notices,
     * and it compares states rather than trusting a marker for exactly that
     * reason.
     */
    this.db.exec(`CREATE TABLE IF NOT EXISTS turn_summaries (
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL DEFAULT 0,
        origin TEXT,
        state TEXT NOT NULL,
        started_at INTEGER,
        ended_at INTEGER,
        input_line TEXT NOT NULL DEFAULT '',
        item_count INTEGER NOT NULL DEFAULT 0,
        item_titles TEXT NOT NULL DEFAULT '[]',
        answer_head TEXT NOT NULL DEFAULT '',
        answer_chars INTEGER NOT NULL DEFAULT 0,
        failure_text TEXT,
        PRIMARY KEY(session_id, run_id)
      );
      CREATE INDEX IF NOT EXISTS turn_summaries_outline ON turn_summaries(session_id, sequence);`);
    this.searchIndex = this.openSearchIndex();
    /**
     * ADDITIVE, AND `user_version` STAYS AT 1 ON PURPOSE — a column with a
     * default is not a downgrade fence. An older binary names the three columns
     * it knows in its INSERT and the new one defaults, so a build without this
     * change still reads and writes the table correctly.
     *
     * ROWS FROM BEFORE THE COLUMN CARRY 0 and go on the very first sweep. They
     * are exactly the backlog this is for — 299k markers accumulated over
     * months — and a receipt has no other record of its age to recover.
     */
    if (!this.db.prepare("PRAGMA table_info(receipts)").all().some((column) => String(column.name) === "at"))
      this.db.exec("ALTER TABLE receipts ADD COLUMN at INTEGER NOT NULL DEFAULT 0");
    if (!this.db.prepare("SELECT value FROM metadata WHERE key='imported'").get()) this.importLegacy();
    atomicWrite(path.join(root, "execution-store.json"), { version: 1, backend: "sqlite" });
    // A previous binary must fail closed instead of reading stale JSON state.
    for (const sessionId of this.sessionIds()) this.fenceLegacy(sessionId);
    this.housekeeping.receipts = this.pruneReceipts();
    const backup = this.sweepLegacyBackup();
    if (backup) this.housekeeping.backup = backup;
    } catch (error) { this.db.close(); throw error; }
    // AFTER the constructor can still throw: a timer armed on a store that
    // failed to open would fire against a closed database. Never the reason a
    // process stays up, like the flush timer.
    this.pruneTimer = setInterval(() => {
      if (this.closed) return;
      // A timer has no caller to throw at, and housekeeping is not worth taking
      // the daemon down for; the next sweep covers whatever this one missed.
      try { this.pruneReceipts(); } catch {}
    }, RECEIPT_PRUNE_EVERY_MS);
    this.pruneTimer.unref?.();
  }

  /**
   * DROP THE RECEIPTS NOTHING CAN STILL REPLAY — on open, and once a day after.
   *
   * Returns how many rows went, which is what a test can assert on: the table
   * is not otherwise observable, and "the receipt no longer replays" is the
   * behaviour that actually matters.
   */
  pruneReceipts(): number {
    const cutoff = this.now() - this.receiptRetentionMs;
    let removed = 0;
    this.alone(() => {
      this.statement("DELETE FROM receipts WHERE at < ?").run(cutoff);
      removed = Number(this.statement("SELECT changes() AS count").get()?.count ?? 0);
    });
    return removed;
  }

  /**
   * DROP THE JSON THE IMPORT REPLACED, ONCE SQLITE HAS OWNED THE STORE A WEEK.
   *
   * `importLegacy` keeps a copy of everything it read, as an undo for a
   * migration that went wrong. That copy is worth having for the days after the
   * migration and worthless after them: a store read and written through sqlite
   * for a week has diverged from it completely, so restoring it would discard
   * the week rather than recover it. On the dogfood home it was 239 MB, months
   * old, beside a 735 MB database (#457).
   *
   * WHEN SQLITE TOOK OVER, FROM TWO SOURCES. `imported-at` is stamped by the
   * import from this store's own clock and is the honest answer. A store
   * migrated by an older build has no such row, so the BACKUP DIRECTORY'S OWN
   * mtime stands in — it was created by that import and nothing writes to it
   * afterwards. Falling back to "unknown, therefore keep" would mean the
   * backlog this exists for is the one case it never reaches.
   *
   * IT DELETES ONE EXACT PATH and computes it rather than taking it, so there
   * is no argument that can point this at anything else. Returns what went, so
   * the daemon can say it and a test can hold it to it — a silent 239 MB
   * deletion is the kind a person only learns about from its absence.
   */
  sweepLegacyBackup(): ExecutionHousekeeping["backup"] {
    const backup = path.join(this.root, "execution-json-backup");
    let stat: fs.Stats;
    try {
      stat = fs.statSync(backup);
    } catch {
      return undefined;
    }
    if (!stat.isDirectory()) return undefined;
    const { bytes, files } = directorySize(backup);
    /**
     * AN EMPTY BACKUP IS NOT A BACKUP, and it goes without a word.
     *
     * `importLegacy` used to create this directory before it knew whether it had
     * anything to put in it, so every store born ON sqlite — which runs the
     * import once and finds nothing — has an empty one. It is the migration's
     * own litter, it preserves nothing, and reporting it would put "removed 0
     * files, 0.0 MB" in the log of a machine that never migrated.
     */
    if (files === 0) {
      fs.rmSync(backup, { recursive: true, force: true });
      return undefined;
    }
    const stamped = this.statement("SELECT value FROM metadata WHERE key='imported-at'").get();
    const importedAt = stamped ? Number(stamped.value) : stat.mtimeMs;
    const ageMs = this.now() - (Number.isFinite(importedAt) ? importedAt : stat.mtimeMs);
    if (ageMs < this.legacyBackupRetentionMs) return { removed: false, bytes, files, ageMs };
    fs.rmSync(backup, { recursive: true, force: true });
    return { removed: true, bytes, files, ageMs };
  }
  owns(file: string): boolean {
    const key = path.relative(this.root, file);
    return key === "task-stops.json" || key === "subscriptions.json"
      || /^sessions\/[A-Za-z0-9_-]+\/(session|queue|items|requests|tasks)\.json$/.test(key)
      // The offset indexes beside the documents they describe (#419). They are
      // derived, but they belong to the same transaction as their document —
      // an index committed while its document rolled back would describe bytes
      // that are not there.
      || /^sessions\/[A-Za-z0-9_-]+\/(queue|items)\.index\.json$/.test(key);
  }
  read(file: string): unknown {
    const row = this.statement("SELECT value FROM documents WHERE key=?").get(path.relative(this.root, file));
    return row ? JSON.parse(String(row.value)) : undefined;
  }
  write(file: string, value: unknown): void {
    this.writeText(file, JSON.stringify(value));
  }
  /** The same write for a caller holding the exact text an index describes. */
  writeText(file: string, text: string): void {
    this.statement("INSERT INTO documents(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(path.relative(this.root, file), text);
    if (path.basename(file) === "session.json") this.fenceLegacy(path.basename(path.dirname(file)));
  }
  /**
   * A document's size in BYTES, and a span of it, without handing the rest to
   * JavaScript (#419).
   *
   * `CAST(value AS BLOB)` is the whole point of both: sqlite's `length` and
   * `substr` count characters over TEXT and bytes over BLOB, and a conversation
   * full of non-ASCII makes those two different numbers. Bytes are what the
   * index records and what the file store can seek to, so bytes are what these
   * answer.
   */
  byteLength(file: string): number | undefined {
    const row = this.statement("SELECT length(CAST(value AS BLOB)) AS size FROM documents WHERE key=?").get(path.relative(this.root, file));
    return row ? Number(row.size) : undefined;
  }
  /** `[start, end)` of the stored document, as bytes. */
  slice(file: string, start: number, end: number): Buffer | undefined {
    if (end <= start) return Buffer.alloc(0);
    const row = this.statement("SELECT substr(CAST(value AS BLOB),?,?) AS span FROM documents WHERE key=?")
      .get(start + 1, end - start, path.relative(this.root, file));
    if (!row) return undefined;
    const span = row.span;
    return Buffer.isBuffer(span) ? span : Buffer.from(span as Uint8Array);
  }
  /**
   * A WINDOW OF THE JOURNAL, `(after, ...]` in id order — issue #494.
   *
   * `limit` IS PUSHED INTO SQLITE, not applied to the answer: the whole point
   * is that a 50k-event session never materialises 50k rows of JSON in this
   * process to hand back two hundred. Absent, the read is the whole tail, which
   * is what the export and the in-process folds still want.
   *
   * THE HELD DELTAS ARE PART OF THE PAGE, and they come last because they are
   * newer than every stored row (see `buffered`). So a page is filled from the
   * disk first and topped up from the buffer only if the disk left room — the
   * same order `cursor` reports, which is what keeps a keyset caller from
   * stepping over a delta that had not been flushed when it asked.
   */
  events(sessionId: string, after = 0, limit?: number): EngineEvent[] {
    const bounded = limit !== undefined && Number.isSafeInteger(limit) && limit > 0;
    const stored = (bounded
      ? this.statement("SELECT value FROM events WHERE session_id=? AND id>? ORDER BY id LIMIT ?").all(sessionId, after, limit)
      : this.statement("SELECT value FROM events WHERE session_id=? AND id>? ORDER BY id").all(sessionId, after)
    ).map((row) => JSON.parse(String(row.value)) as EngineEvent);
    if (bounded && stored.length >= limit!) return stored;
    const held = this.held().filter((event) => event.sessionId === sessionId && event.id > after);
    if (!held.length) return stored;
    const page = [...stored, ...held];
    return bounded ? page.slice(0, limit) : page;
  }
  cursor(sessionId: string): number {
    const known = this.cursors.get(sessionId);
    if (known !== undefined) return known;
    const stored = Number(this.statement("SELECT COALESCE(MAX(id),0) AS id FROM events WHERE session_id=?").get(sessionId)?.id ?? 0);
    const head = this.held().reduce((highest, event) => event.sessionId === sessionId && event.id > highest ? event.id : highest, stored);
    this.cursors.set(sessionId, head);
    return head;
  }
  append(event: EngineEvent): void {
    this.cursors.set(event.sessionId, Math.max(event.id, this.cursors.get(event.sessionId) ?? 0));
    if (event.type !== "content.delta") {
      // Nothing may reach the disk ahead of a buffered delta; see `buffered`.
      // Outside a transaction that has to be ONE of them, or the batch this
      // event just settled would go to the disk a row and an fsync at a time.
      this.alone(() => { this.drain(this.depth > 0); this.insert(event); });
      return;
    }
    (this.depth > 0 ? this.pending : this.buffered).push(event);
    if (this.bufferedSince === 0) this.bufferedSince = Date.now();
    if (this.buffered.length + this.pending.length >= this.flushCount) this.flush();
    else this.arm();
  }
  /**
   * SEEKS THE PREFIX, THEN FILTERS THE SUFFIX — see `prefixRange`.
   *
   * The range is what makes this an index seek; the `LIKE` that remains only
   * chooses between the five documents a session directory holds, over rows the
   * seek has already narrowed to. It reads keys alone and never touches `value`,
   * so no conversation text is loaded to answer it.
   */
  sessionIds(): string[] {
    const [low, high] = prefixRange("sessions/");
    return this.statement("SELECT key FROM documents WHERE key >= ? AND key < ? AND key LIKE '%/session.json' ORDER BY key")
      .all(low, high).map((row) => String(row.key).split("/")[1]!);
  }
  /**
   * WHICH SESSIONS HAVE A ROW AND WHICH DO NOT — the backfill's own question.
   *
   * Keys alone on both sides, so answering it reads no conversation text: the
   * `documents` side is the covering seek `sessionIds` makes, and the `sessions`
   * side is the primary key. `missing` is what a first open (or an open after a
   * downgrade wrote documents this table never saw) has to compute; `orphaned`
   * is a row whose session was deleted by a binary that did not know to remove
   * it. Both are returned rather than acted on here, because building a row
   * means folding four documents and that is the state layer's job.
   */
  sessionRowGaps(): { missing: string[]; orphaned: string[] } {
    const documents = new Set(this.sessionIds());
    const rows = new Set(this.statement("SELECT id FROM sessions").all().map((row) => String(row.id)));
    return {
      missing: [...documents].filter((id) => !rows.has(id)),
      orphaned: [...rows].filter((id) => !documents.has(id)),
    };
  }

  /**
   * THE LIVE FOLD'S READ: every row that is not archived.
   *
   * `archived = 0` is the leading column of `sessions_shelf`, so this is a seek
   * past the finished conversations rather than a scan over them — and an
   * archived session is one the live list never carries, so the rows it skips
   * are rows no caller would have looked at.
   *
   * NO `ORDER BY`, DELIBERATELY. The answer is ordered by `newestFirst` over
   * whole `Session` records anyway — the index cannot serve that order with
   * `settled_override` sitting between `archived` and `updated_at`, so asking
   * for it here buys a temp B-tree over every row and a second sort afterwards.
   */
  liveSessionRows(): SessionIndexRow[] {
    return this.statement("SELECT * FROM sessions WHERE archived = 0").all().map(rowFromColumns);
  }

  /** One row, by primary key — what a writer reads to learn whether the row it
   *  is about to store changes which list this session is on. */
  sessionRow(sessionId: string): SessionIndexRow | undefined {
    const columns = this.statement("SELECT * FROM sessions WHERE id=?").get(sessionId);
    return columns ? rowFromColumns(columns) : undefined;
  }

  /** One project's rows, by the index that exists for them. Unordered, for the
   *  reason above: `readSessions` sorts the records it builds from these. */
  projectSessionRows(projectId: string): SessionIndexRow[] {
    return this.statement("SELECT * FROM sessions WHERE project_id=?").all(projectId).map(rowFromColumns);
  }

  /**
   * Store one row. Called from inside the transaction that wrote the document
   * the row describes — never as a pass of its own, because a row committed
   * without its document (or the other way round) is a sidebar disagreeing with
   * the conversation it is drawing.
   */
  writeSessionRow(row: SessionIndexRow): void {
    this.statement(`INSERT INTO sessions(
        id, project_id, state, archived, draft, created_at, updated_at, read_at, settled_override, settled_at,
        snoozed_until, snoozed_at, last_turn_sequence, last_read_turn_sequence, last_turn_ended_at, last_turn_failed,
        activity, activity_at, title, branch)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        project_id=excluded.project_id, state=excluded.state, archived=excluded.archived, draft=excluded.draft,
        created_at=excluded.created_at, updated_at=excluded.updated_at, read_at=excluded.read_at,
        settled_override=excluded.settled_override, settled_at=excluded.settled_at,
        snoozed_until=excluded.snoozed_until, snoozed_at=excluded.snoozed_at,
        last_turn_sequence=excluded.last_turn_sequence, last_read_turn_sequence=excluded.last_read_turn_sequence,
        last_turn_ended_at=excluded.last_turn_ended_at, last_turn_failed=excluded.last_turn_failed,
        activity=excluded.activity, activity_at=excluded.activity_at,
        title=excluded.title, branch=excluded.branch`).run(
      row.id, row.projectId ?? null, row.state, row.archived ? 1 : 0, row.draft ? 1 : 0,
      row.createdAt, row.updatedAt, row.readAt ?? null, row.settledOverride ?? null, row.settledAt ?? null,
      row.snoozedUntil ?? null, row.snoozedAt ?? null, row.lastTurnSequence ?? null, row.lastReadTurnSequence ?? null,
      row.lastTurnEndedAt ?? null, row.lastTurnFailed ? 1 : 0, row.activity, row.activityAt ?? null,
      row.title ?? null, row.branch ?? null);
    this.writeSessionSearchRow(row.id, row.title ?? "", row.branch ?? "");
  }

  deleteSessionRow(sessionId: string): void {
    this.statement("DELETE FROM sessions WHERE id=?").run(sessionId);
    this.statement("DELETE FROM turn_summaries WHERE session_id=?").run(sessionId);
    if (this.searchIndex === "fts5") this.statement("DELETE FROM session_search WHERE session_id=?").run(sessionId);
  }

  /**
   * ══ THE TURN PROJECTION — issue #516 ══
   *
   * Build the search table, or report that this sqlite cannot have one. Called
   * once, from the constructor; everything below branches on the answer.
   *
   * THE PROBE IS A CREATE, NOT A VERSION CHECK. `PRAGMA compile_options` would
   * tell us what the library was built with and nothing about whether this
   * binding exposes it; attempting the statement is the only question whose
   * answer is the thing we actually need. A failure is not an error — it is one
   * of the two supported configurations — so it is swallowed and recorded.
   */
  private openSearchIndex(): "fts5" | "like" {
    try {
      this.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS session_search USING fts5(
           text, session_id UNINDEXED, run_id UNINDEXED, tokenize='unicode61 remove_diacritics 2')`,
      );
      return "fts5";
    } catch {
      return "like";
    }
  }

  /**
   * WHAT THE PROJECTION BELIEVES EACH TURN'S STATE IS — the reconcile's question.
   *
   * Two columns, by the primary key, with no document text on either side: the
   * caller compares this against the queue index's own `(runId, state)` pairs and
   * re-folds only the turns that disagree. That is what makes maintaining the
   * projection cost nothing on a write that moved one turn, and what makes the
   * backfill and the steady state the same code.
   */
  turnSummaryStates(sessionId: string): Array<{ runId: string; state: string }> {
    return this.statement("SELECT run_id, state FROM turn_summaries WHERE session_id=?")
      .all(sessionId)
      .map((row) => ({ runId: String(row.run_id), state: String(row.state) }));
  }

  /** Store one turn's row, inside the transaction that settled the turn — the
   *  rule `writeSessionRow` states, for the same reason. */
  writeTurnSummary(row: TurnSummary): void {
    this.statement(`INSERT INTO turn_summaries(
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
    if (this.searchIndex !== "fts5") return;
    // DELETE THEN INSERT: fts5 has no upsert, and an UPDATE over a contentless
    // row would leave the old terms in the index to match against.
    this.statement("DELETE FROM session_search WHERE session_id=? AND run_id=?").run(row.sessionId, row.runId);
    this.statement("INSERT INTO session_search(text, session_id, run_id) VALUES(?,?,?)")
      .run(`${row.input}\n${row.answerHead}`, row.sessionId, row.runId);
  }

  /** A row whose turn left the queue. See `reconcileTurnSummaries`. */
  deleteTurnSummary(sessionId: string, runId: string): void {
    this.statement("DELETE FROM turn_summaries WHERE session_id=? AND run_id=?").run(sessionId, runId);
    if (this.searchIndex === "fts5") this.statement("DELETE FROM session_search WHERE session_id=? AND run_id=?").run(sessionId, runId);
  }

  /** The session's own searchable text — its title and its branch, under the
   *  empty run id so one table answers both halves of `find`. */
  writeSessionSearchRow(sessionId: string, title: string, branch: string): void {
    if (this.searchIndex !== "fts5") return;
    this.statement("DELETE FROM session_search WHERE session_id=? AND run_id=''").run(sessionId);
    this.statement("INSERT INTO session_search(text, session_id, run_id) VALUES(?,?,'')").run(`${title}\n${branch}`, sessionId);
  }

  /**
   * THE OUTLINE'S PAGE: this session's turns, newest first, keyset by sequence.
   *
   * `before` IS A SEQUENCE, NOT AN OFFSET, for the reason the journal's `after`
   * is an event id: a session being appended to while a caller pages it would
   * drop or repeat rows under `LIMIT ... OFFSET`, and an orchestrator paging a
   * live conversation is the ordinary case rather than the exotic one.
   *
   * One over the limit is read and dropped by the caller, so `more` is exact.
   */
  outlineRows(sessionId: string, before: number | undefined, limit: number): TurnSummary[] {
    const rows = before === undefined
      ? this.statement("SELECT * FROM turn_summaries WHERE session_id=? ORDER BY sequence DESC LIMIT ?").all(sessionId, limit)
      : this.statement("SELECT * FROM turn_summaries WHERE session_id=? AND sequence<? ORDER BY sequence DESC LIMIT ?").all(sessionId, before, limit);
    return rows.map(turnFromColumns);
  }

  turnSummary(sessionId: string, runId: string): TurnSummary | undefined {
    const columns = this.statement("SELECT * FROM turn_summaries WHERE session_id=? AND run_id=?").get(sessionId, runId);
    return columns ? turnFromColumns(columns) : undefined;
  }

  /** The newest turn that left an answer — `/answer`'s default run. A turn that
   *  ended without text is not one, which is what `answer_chars > 0` says. */
  latestAnsweredTurn(sessionId: string): TurnSummary | undefined {
    const columns = this.statement(
      "SELECT * FROM turn_summaries WHERE session_id=? AND state='completed' AND answer_chars>0 ORDER BY sequence DESC LIMIT 1",
    ).get(sessionId);
    return columns ? turnFromColumns(columns) : undefined;
  }

  /** How many turns this session has a row for — the outline's `total`. */
  turnSummaryCount(sessionId: string): number {
    return Number(this.statement("SELECT COUNT(*) AS count FROM turn_summaries WHERE session_id=?").get(sessionId)?.count ?? 0);
  }

  /**
   * LEXICAL SEARCH ACROSS EVERY CONVERSATION — `find`'s one read.
   *
   * ON FTS5 WHEN THERE IS ONE: the match is an inverted-index lookup and the
   * scan is over the rows it returns. WITHOUT ONE: a bounded `LIKE` over the same
   * two columns of `turn_summaries` plus the two on `sessions` — which is a scan,
   * and is why it is capped by `scan` rather than trusted to be selective. Both
   * read only projection rows; neither opens a document or folds an event.
   *
   * THE ROW CARRIES ITS OWN `why`. A hit with no quotation is a caller taking the
   * engine's word for it, and the whole point of the verb is to let an agent
   * decide which conversation to open next.
   */
  searchTurnText(terms: string[], scan: number): Array<{ sessionId: string; runId: string; text: string }> {
    if (terms.length === 0) return [];
    if (this.searchIndex === "fts5") {
      // EVERY TERM QUOTED AS A PHRASE, so a user's `index.lock` or `-` is text
      // rather than fts5 syntax: the query language has operators a person
      // searching their own conversations never meant to type.
      const query = terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(" AND ");
      return this.statement("SELECT text, session_id, run_id FROM session_search WHERE session_search MATCH ? ORDER BY rank LIMIT ?")
        .all(query, scan)
        .map((row) => ({ sessionId: String(row.session_id), runId: String(row.run_id), text: String(row.text) }));
    }
    const like = `%${escapeLike(terms[0]!)}%`;
    const rows = this.statement(
      `SELECT session_id, run_id, input_line || char(10) || answer_head AS text FROM turn_summaries
         WHERE input_line LIKE ? ESCAPE '\\' OR answer_head LIKE ? ESCAPE '\\'
         ORDER BY session_id, sequence DESC LIMIT ?`,
    ).all(like, like, scan);
    const titles = this.statement(
      `SELECT id AS session_id, '' AS run_id, COALESCE(title,'') || char(10) || COALESCE(branch,'') AS text FROM sessions
         WHERE title LIKE ? ESCAPE '\\' OR branch LIKE ? ESCAPE '\\' LIMIT ?`,
    ).all(like, like, scan);
    return [...titles, ...rows].map((row) => ({ sessionId: String(row.session_id), runId: String(row.run_id), text: String(row.text) }));
  }

  /**
   * WHERE A PATTERN APPEARS IN ONE SESSION'S JOURNAL — `grep`'s read.
   *
   * THIS ONE DOES TOUCH EVENTS, and it is the only route that does: "where did
   * it mention index.lock" is a question about the raw text, and no projection
   * small enough to be worth keeping could answer it. What makes it affordable is
   * that the scan runs INSIDE sqlite and only `limit` rows are ever materialised
   * in JavaScript — the 38 MB an outline used to fold is read as pages by the C
   * layer and discarded, rather than parsed into 62,000 objects.
   *
   * NEWEST FIRST, KEYSET BY EVENT ID, like every other page here.
   */
  grepEvents(sessionId: string, needle: string, before: number | undefined, limit: number): Array<{ id: number; value: string }> {
    const like = `%${escapeLike(needle)}%`;
    const rows = before === undefined
      ? this.statement("SELECT id, value FROM events WHERE session_id=? AND value LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?").all(sessionId, like, limit)
      : this.statement("SELECT id, value FROM events WHERE session_id=? AND id<? AND value LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?").all(sessionId, before, like, limit);
    return rows.map((row) => ({ id: Number(row.id), value: String(row.value) }));
  }

  /** Which sessions have no turn rows at all — what the backfill folds. Keys on
   *  both sides, exactly as `sessionRowGaps` is, and for the same reason. */
  turnSummaryGaps(): string[] {
    const summarised = new Set(this.statement("SELECT DISTINCT session_id FROM turn_summaries").all().map((row) => String(row.session_id)));
    return this.sessionIds().filter((id) => !summarised.has(id));
  }

  /** Run `work` as one transaction, for a caller outside a command that still
   *  has to write a document and its row together. */
  atomically(work: () => void): void {
    this.alone(work);
  }

  deleteSession(sessionId: string): void {
    this.alone(() => {
      // Store the held deltas so the DELETE below is what decides they are gone —
      // and so a rollback brings back a whole session, not a truncated one.
      this.drain(this.depth > 0);
      // A RANGE, NOT `substr(key,1,?)=?`: see `prefixRange`. The old spelling
      // computed a substring of every key in the table to delete five rows.
      const [low, high] = prefixRange(`sessions/${sessionId}/`);
      this.statement("DELETE FROM documents WHERE key >= ? AND key < ?").run(low, high);
      this.statement("DELETE FROM events WHERE session_id=?").run(sessionId);
      // In the SAME transaction as the documents, for the reason
      // `writeSessionRow` gives: a row outliving its conversation is a row on
      // somebody's rail that cannot be opened.
      this.deleteSessionRow(sessionId);
      this.cursors.delete(sessionId);
    });
  }
  /** Every delta this store has accepted and not yet stored. `writtenAhead` is
   *  excluded: it is in the database already, awaiting its commit. */
  private held(): EngineEvent[] {
    return this.buffered.length || this.pending.length ? [...this.buffered, ...this.pending] : [];
  }
  private insert(event: EngineEvent): void {
    this.statement("INSERT INTO events(session_id,id,value) VALUES(?,?,?)").run(event.sessionId, event.id, JSON.stringify(event));
  }
  /** Store everything held, in the write scope that is open right now.
   *  `track` records the settled ones a caller has to hand back on a rollback. */
  private drain(track: boolean): void {
    if (!this.buffered.length && !this.pending.length) return;
    for (const event of this.buffered) { this.insert(event); if (track) this.writtenAhead.push(event); }
    for (const event of this.pending) this.insert(event);
    this.buffered = [];
    this.pending = [];
    this.disarm();
  }
  /** Run `work` as one transaction, or inline when one is already open.
   *  Deliberately not `transaction()`: no receipt belongs to a flush. */
  private alone(work: () => void): void {
    if (this.depth > 0) return work();
    const settled = this.buffered;
    this.db.exec("BEGIN IMMEDIATE");
    this.depth += 1;
    try { work(); this.db.exec("COMMIT"); }
    catch (error) {
      this.db.exec("ROLLBACK");
      // What this rolled back was settled before it started; hand it back
      // rather than lose it to a failure that came after.
      this.buffered.unshift(...settled.filter((event) => !this.buffered.includes(event)));
      this.cursors.clear();
      throw error;
    } finally { this.depth -= 1; }
  }
  /** Store what is held, in a transaction of its own — or, inside one already,
   *  as part of it. `transaction` flushes what is settled before it begins. */
  private flush(): void {
    if (this.depth > 0) return this.drain(true);
    if (!this.buffered.length) return;
    this.alone(() => this.drain(false));
  }
  private arm(): void {
    if (this.flushTimer) return;
    // Never the reason a process stays up: an exit flushes through `close`.
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      if (this.closed) return;
      // A timer has no caller to throw at, and an unhandled one here would take
      // the daemon down over a write that the next flush will retry anyway.
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
    // Deltas this store already answers for are settled by an earlier commit,
    // so they are stored on their own rather than inside — and taken back by —
    // whatever this transaction turns out to do.
    if (this.buffered.length && Date.now() - this.bufferedSince >= this.flushAfterMs) this.flush();
    const receiptId = commandId ?? crypto.randomUUID();
    const changesBefore = Number(this.statement("SELECT total_changes() AS count").get()?.count ?? 0);
    this.db.exec("BEGIN IMMEDIATE");
    this.depth += 1;
    try {
      // A receipt id this call just minted cannot already be on file, so the
      // lookup is skipped entirely unless a CALLER supplied the id — which is
      // the only case where a replay is possible.
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
        // Internal receipts are audit markers, not replayable responses. In
        // particular, never retain a resolved worker claim's provider secrets.
        this.statement("INSERT INTO receipts(id,command,result,at) VALUES(?,?,?,?)").run(receiptId, command,
          JSON.stringify(commandId === undefined ? {} : { value: result }), this.now());
      this.db.exec("COMMIT");
      this.settle();
      return result;
    } catch (error) { this.db.exec("ROLLBACK"); this.revert(); throw error; }
    finally { this.depth -= 1; }
  }
  /** The deltas appended in the transaction that just committed are now this
   *  store's to answer for, and the ones it wrote are the disk's. */
  private settle(): void {
    if (this.pending.length) {
      this.buffered.push(...this.pending);
      this.pending = [];
      if (this.bufferedSince === 0) this.bufferedSince = Date.now();
      this.arm();
    }
    this.writtenAhead = [];
  }
  /** A rollback takes back what the transaction appended — and hands back what
   *  it had written on an earlier transaction's behalf. */
  private revert(): void {
    this.pending = [];
    if (this.writtenAhead.length) {
      this.buffered.unshift(...this.writtenAhead);
      this.writtenAhead = [];
      this.arm();
    }
    // Ids assigned inside the rolled-back transaction are gone from the
    // database; `cursor` re-reads, counting whatever is still held.
    this.cursors.clear();
  }
  exportLegacy(destination: string): void {
    if (fs.existsSync(destination)) throw new Error("Export destination must not already exist");
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
    for (const row of this.db.prepare("SELECT key,value FROM documents ORDER BY key").all()) {
      // The offset indexes describe THIS store's compact text; an export
      // pretty-prints, so carrying them over would ship offsets into bytes the
      // exported file does not have. They are derived — the next write rebuilds
      // them, and a read without one is whole-document and correct.
      if (String(row.key).endsWith(".index.json")) continue;
      const file = path.join(destination, String(row.key));
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      atomicWrite(file, JSON.parse(String(row.value)));
    }
    for (const id of this.sessionIds()) {
      const events = this.events(id);
      fs.writeFileSync(path.join(destination, "sessions", id, "events.ndjson"), events.map((event) => JSON.stringify(event) + "\n").join(""), { mode: 0o600 });
    }
  }
  close(): void {
    if (this.closed) return;
    this.disarm();
    if (this.pruneTimer) { clearInterval(this.pruneTimer); this.pruneTimer = undefined; }
    // An orderly shutdown stores the tail. Only a crash may lose it.
    try { this.flush(); } finally { this.statements.clear(); this.cursors.clear(); this.db.close(); this.closed = true; }
  }
  private fenceLegacy(sessionId: string): void {
    const file = path.join(this.root, "sessions", sessionId, "session.json");
    // Avoid a disk write per metadata update; this is an immutable downgrade fence.
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8").includes('"backend": "sqlite"')) return;
    atomicWrite(file, { version: -1, backend: "sqlite", message: "This history requires a SQLite-capable Telar build." });
  }
  private importLegacy(): void {
    const backup = path.join(this.root, "execution-json-backup");
    // NOT CREATED UNTIL THERE IS SOMETHING TO PUT IN IT (#457). This ran
    // unconditionally, so every store born ON sqlite — which runs the import
    // once and finds nothing to import — was left with an empty directory that
    // then sat there for the life of the home. `copyToBackup` makes it.
    this.transaction("import", () => {
      for (const entry of fs.readdirSync(path.join(this.root, "sessions"), { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^[A-Za-z0-9_-]+$/.test(entry.name)) continue;
        for (const name of [...FILES, "events.ndjson"]) {
          const file = path.join(this.root, "sessions", entry.name, name);
          if (!fs.existsSync(file)) continue;
          const raw = fs.readFileSync(file, "utf8");
          const saved = path.join(backup, entry.name, name);
          fs.mkdirSync(path.dirname(saved), { recursive: true, mode: 0o700 });
          if (!fs.existsSync(saved)) fs.copyFileSync(file, saved, fs.constants.COPYFILE_EXCL);
          if (name === "events.ndjson") {
            const lines = raw.split("\n");
            // Only a torn final append may be ignored; corrupt committed rows fail import.
            if (!raw.endsWith("\n") && lines.at(-1)) {
              try { JSON.parse(lines.at(-1)!); } catch { lines.pop(); }
            }
            let previous = 0;
            for (const line of lines) if (line) {
              const event = EngineEvent.parse(JSON.parse(line));
              if (event.sessionId !== entry.name || !Number.isSafeInteger(event.id) || event.id <= previous)
                throw new Error(`Invalid journal sequence in ${entry.name}`);
              this.append(event); previous = event.id;
            }
          } else {
            const value = JSON.parse(raw);
            this.statement("INSERT INTO documents(key,value) VALUES(?,?)").run(`sessions/${entry.name}/${name}`, JSON.stringify(value));
          }
        }
      }
      for (const name of ["task-stops.json", "subscriptions.json"]) {
        const file = path.join(this.root, name);
        if (fs.existsSync(file)) {
          // Made here rather than up front, for the reason stated above: the
          // per-session copies make their own parents, and this is the only
          // other thing that ever goes in.
          fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
          if (!fs.existsSync(path.join(backup, name))) fs.copyFileSync(file, path.join(backup, name), fs.constants.COPYFILE_EXCL);
          this.write(file, JSON.parse(fs.readFileSync(file, "utf8")));
        }
      }
      this.db.prepare("INSERT INTO metadata(key,value) VALUES('imported','1')").run();
      // WHEN SQLITE TOOK OVER, so the backup above can be aged honestly rather
      // than from a directory mtime (#457). Written inside the same transaction
      // as the marker beside it: a store that is "imported" with no date would
      // be a store the sweep has to guess about.
      this.db.prepare("INSERT INTO metadata(key,value) VALUES('imported-at',?)").run(String(this.now()));
    });
  }
}
