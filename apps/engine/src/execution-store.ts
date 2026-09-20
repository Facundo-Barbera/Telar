import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { EngineEvent, idleSince, isShelved, settlingActivityOf } from "@telar/engine-client";
import { atomicWrite } from "./atomic";
import { statePaths } from "./state-paths";
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
 * THE TURN STATES AFTER WHICH A TURN'S ITEMS ARE FINAL — see `compactJournal`.
 *
 * `turn.steered`, `turn.requeued` and `turn.released` are deliberately absent:
 * they move a turn without ending it, and the items under them are still open.
 */
const TERMINAL_TURN_TYPES = ["turn.completed", "turn.failed", "turn.stopped", "turn.ambiguous", "turn.discarded"] as const;

/**
 * THE SAME FIVE ENDINGS AS `turn_summaries` RECORDS THEM — retention's guard.
 *
 * One list per side because they are different vocabularies: the journal names
 * an EVENT (`turn.completed`) and a summary row carries the turn's own STATE
 * (`completed`). `steered` is absent from both for the same reason
 * `turn.steered` is absent above — it moves a turn's words into another run
 * rather than ending one, and counting it on one side and not the other would
 * make the guard refuse every steered session forever.
 */
const TERMINAL_TURN_STATES = ["completed", "failed", "stopped", "ambiguous", "discarded"] as const;

/**
 * HOW MANY EVENTS A PER-SESSION EXPORT HOLDS IN MEMORY AT ONCE.
 *
 * The point of the paging, not a tuning knob: `exportLegacy` reads a session's
 * whole journal as one array, which on the owner's largest session is 62,000
 * records of conversation text. A page is written and dropped, so resident
 * memory is flat whatever the session's size.
 */
const EXPORT_PAGE = 1_000;

/**
 * WHERE THE COMPACTION OF ONE SESSION GOT TO — `metadata`, one row per session.
 *
 * The sweep is incremental because the alternative is re-examining a million
 * settled rows every day to find the few hundred that are new. The row holds
 * the id of the last terminal turn event compacted; the next sweep considers
 * `(watermark, newBoundary]` and nothing below it, so every event in the
 * journal is examined exactly once in its life.
 */
const COMPACT_WATERMARK_PREFIX = "journal-compacted/";

/**
 * WHERE THE USAGE FOLD OF ONE SESSION GOT TO — issue #697, and ITS OWN KEY.
 *
 * This constant exists because reusing the one above would be silent and fatal.
 * `low` is read as `Number(stored?.value ?? 0)`, so a fold that shared
 * `journal-compacted/` would start every already-compacted session at the last
 * terminal turn the COMPACTION reached — past every usage row in the backlog
 * this is for. The sweep would then delete nothing, record nothing, and report
 * success. A separate key starts at 0 on a store that has been compacted for
 * months, which is the only starting point that can see the rows.
 *
 * `usage-fold.test.ts` compacts a fixture first and folds it second for exactly
 * this reason: on a shared key that test finds zero rows.
 */
const USAGE_WATERMARK_PREFIX = "journal-usage-folded/";

/**
 * WHICH SESSIONS HOLD THEIR ITEMS AS ROWS — issue #658, `metadata`, one row per
 * session, and the reason a half-migrated store is a CORRECT store rather than
 * one to be recovered from.
 *
 * The read path asks this before it asks anything else, so the answer is never
 * inferred from whether a document happens to be present. Inferring it is the
 * variant that cannot tell "migrated, blob deleted" from "never written", and
 * those two want opposite answers.
 *
 * THE MARKER, THE ROWS AND THE DELETED BLOB COMMIT TOGETHER — see
 * `migrateItemsToRows`. Swept by `deleteSession` beside the two watermarks
 * above, for their reason: a marker outliving its session would tell a reused
 * id that its items are rows when the rows went with the session.
 */
const ITEMS_ROWS_PREFIX = "items-rows/";

/**
 * THE HIGHEST EVENT ID A SESSION EVER HELD, kept once its journal is gone.
 *
 * Ids are handed out as `cursor(sessionId) + 1`, and `cursor` is
 * `COALESCE(MAX(id),0)` over the rows that are still there. Nothing could empty
 * a session before retention: compaction always leaves `item.completed` and the
 * terminal turn events behind, so the sequence never restarted.
 *
 * RETIRING A JOURNAL CHANGES THAT, AND THE FAILURE IS INVISIBLE UNTIL A
 * RESTART. In memory the cached cursor holds, so nothing breaks while the
 * daemon is up; after a restart the next event on that session gets id 1 again.
 * Everything holding an old cursor — an open cockpit tab, a phone that synced,
 * an MCP caller's `after`, a subscription — then asks for `id > 900` and is
 * told there is nothing, forever, while new events accumulate below it. The
 * compaction watermark would also sit above every new id, so that session would
 * never be compacted again either.
 *
 * So the floor is written in the SAME transaction as the delete, and `cursor`
 * takes the max of the two. Mirrors `COMPACT_WATERMARK_PREFIX` exactly, and is
 * deleted with the session for the same reason that one is.
 */
const JOURNAL_FLOOR_PREFIX = "journal-floor/";

/**
 * HOW FAR DURABILITY HAS REACHED — the row the device barrier commits, #632.
 *
 * The barrier needs a page to write, because a commit with nothing in it
 * produces no WAL frame and therefore nothing to sync: an empty transaction at
 * `synchronous=FULL` is a barrier that never happens. So it writes the id of
 * the terminal turn event it is persisting, which is both a changed page and
 * the only durable answer to "where did the last barrier land" — worth having
 * in a diagnostic, and the reason this is a real row rather than a dummy one.
 */
const DURABILITY_BARRIER_KEY = "durability-barrier";

/** How long after opening the first compaction starts. Long enough that the
 *  daemon is answering before housekeeping touches the database, short enough
 *  that a person who launches Telar to reclaim space does not wait on it. */
const COMPACT_AFTER_OPEN_MS = 5_000;

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
  /** When the engine decided this conversation woke — see `Session.wokeAt`. On
   *  the row because `dueSnoozeWakes` SEEKS on it: "has a wake already been
   *  recorded" is half the sweep's predicate, and a column is what keeps that
   *  question out of 300 documents. */
  wokeAt?: number;
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
    ...(columns.woke_at === null || columns.woke_at === undefined ? {} : { wokeAt: Number(columns.woke_at) }),
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

/**
 * WHAT ONE TURN'S `usage.updated` ROWS ADDED UP TO — issue #697.
 *
 * `rows` is how many there were, and it is not decoration: it is what tells a
 * later reader whether the sum is a turn's spend (Codex, one row per call) or
 * the same figure restated (Claude, whose last row is the total). See the
 * columns on `turn_summaries` for why the fold records both rather than
 * choosing between them.
 */
export type TurnUsageAggregate = {
  tokens: { input: number; output: number; cacheRead: number; cacheCreate: number; reasoning: number };
  rows: number;
};

/**
 * THE TOKENS OFF ONE `usage.updated` ROW, parsed rather than `json_extract`ed.
 *
 * The point of doing it this way is that it is NOT how the fold's other half
 * reads the same rows. sqlite sums them with `SUM(json_extract(...))`; this
 * walks the parsed object. Two computations that could fail differently are
 * what makes the conservation check in `foldUsage` a check and not a restated
 * assumption. A row whose tokens are missing or malformed contributes zero
 * here, and sqlite's `COALESCE(...,0)` says the same — a row that says nothing
 * about tokens has nothing to conserve.
 */
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
  return {
    input: n(tokens.input),
    output: n(tokens.output),
    cacheRead: n(tokens.cacheRead),
    cacheCreate: n(tokens.cacheCreate),
    reasoning: n(tokens.reasoning),
  };
}

/** What the housekeeping on open actually removed, so the daemon can say so and
 *  a test can hold it to it. Nothing here is otherwise observable. */
export type ExecutionHousekeeping = {
  /** Command receipts swept past their retention. */
  receipts: number;
  /** The migration backup, when there was one to consider. `removed: false`
   *  means it is still inside its week. */
  backup?: { removed: boolean; bytes: number; files: number; ageMs: number };
  /** Superseded journal rows dropped by `compactJournal` — issue #646. Zero on
   *  every open after the first unless turns have ended since. */
  journal?: { deltas: number; starts: number; sessions: number };
  /** `usage.updated` rows folded into a per-turn aggregate — issue #697.
   *  `refused` is sessions whose fold rolled back on the conservation check;
   *  it is zero unless something is wrong, which is why it is counted. */
  usage?: { rows: number; turns: number; sessions: number; refused: number };
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
  /** Told what the background journal sweep removed, once it has. The daemon
   *  prints it; a test asserts on it without waiting on a timer. */
  onJournalCompacted?: (swept: { deltas: number; starts: number; sessions: number }) => void;
  /**
   * CALLED ONCE PER DEVICE BARRIER ACTUALLY ISSUED — issue #632, and it counts
   * the real one rather than replacing it.
   *
   * The claim this feature makes is "a barrier per settled turn and none per
   * delta", and the only assertion that can hold it is a COUNT: a marker string
   * is printed by a barrier that did nothing, and a timing is an assertion about
   * the runner's disk. This fires after the barrier's own commit returns, so a
   * barrier that threw is not counted — which is the direction that matters,
   * since the failure state must not look like the success one.
   */
  onDurabilityBarrier?: (at: { sessionId: string; eventId: number }) => void;
  /**
   * RUN THE RETENTION SWEEP ON THIS STORE'S OWN HOUSEKEEPING CADENCE — #542.
   *
   * A callback rather than a method because the ELIGIBILITY needs a document
   * this object does not read: the window and the export destination live in
   * `retention.json`, which is the state layer's. What lives here is the
   * mechanism — the predicate, the guards, the floor — so the two halves meet
   * at one function and neither grows a second opinion about the other.
   *
   * Never on the open path. See the compaction timer in the constructor.
   */
  onRetentionSweep?: () => void;
  /**
   * How long after opening the first sweep starts. Defaults to
   * `COMPACT_AFTER_OPEN_MS`; nothing in production passes it.
   *
   * IT EXISTS SO A TEST NEED NOT SLEEP THROUGH IT (#706). Asserting the sweep
   * ran meant waiting out the real five seconds and then hoping the callback
   * had fired — a test whose margin was four hundred milliseconds of a shared
   * machine, which is not an assertion about this store at all. Worse, it put
   * a 5.4 s sleep in a suite that a bare root-level `bun test` runs under
   * bun's 5 s default, so the test could not pass there at any load. With the
   * delay injectable the test waits for the callback instead of the clock, and
   * asserts what the sweep REMOVED, which is the same answer on an idle
   * machine and a loaded one.
   */
  compactAfterOpenMs?: number;
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
  private compactTimer?: ReturnType<typeof setTimeout>;
  /** Said out loud by the daemon when the background sweep finds something.
   *  A callback rather than a return because the sweep no longer happens while
   *  anybody is waiting on the open — see the constructor. */
  private readonly onJournalCompacted?: (swept: { deltas: number; starts: number; sessions: number }) => void;
  private readonly onDurabilityBarrier?: (at: { sessionId: string; eventId: number }) => void;
  private readonly onRetentionSweep?: () => void;
  /**
   * THE TERMINAL TURN EVENT THIS WRITE SCOPE APPENDED, if it appended one.
   *
   * Set by `append`, read and cleared by `maybeBarrier` once the scope commits.
   * A number rather than a boolean because the barrier writes it down: see
   * `DURABILITY_BARRIER_KEY`. Cleared by a rollback too — a turn that did not
   * commit has nothing to persist, and issuing a barrier for it would be
   * claiming a settlement that never happened.
   */
  private barrierDue?: { sessionId: string; eventId: number };
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
    if (options.onJournalCompacted) this.onJournalCompacted = options.onJournalCompacted;
    if (options.onDurabilityBarrier) this.onDurabilityBarrier = options.onDurabilityBarrier;
    if (options.onRetentionSweep) this.onRetentionSweep = options.onRetentionSweep;
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
     *
     * ══ AND `checkpoint_fullfsync=ON`, WHICH CLOSES A RUNTIME DIVERGENCE ══
     *
     * On macOS `fsync(2)` is not a device barrier. Its own man page says so —
     * "the drive itself may not physically write the data to the platters for
     * quite some time… this is not a theoretical edge case" — and `F_FULLFSYNC`
     * is the call that asks the drive to flush its own cache. `checkpoint_
     * fullfsync` is what makes sqlite use the second one when it checkpoints.
     *
     * IT WAS ON HERE AND OFF IN THE SHIPPED APP, BY ACCIDENT (#632). The dev
     * stack runs `bun:sqlite` over Apple's system libsqlite3, which is compiled
     * with `DEFAULT_CKPTFULLFSYNC`, so every measurement this repository has
     * ever taken was on a connection that already had it. The packaged app runs
     * the engine under Electron-as-Node on `node:sqlite`, whose bundled
     * amalgamation is not — so the build a person actually uses issued NO
     * device barrier anywhere at steady state, and the one developers use did.
     * Setting it explicitly makes the two the same, in the stronger direction.
     *
     * WHAT IT COSTS, MEASURED RATHER THAN ASSUMED (`bench:durability`, on the
     * shipped `node:sqlite`): a long streaming session checkpoints once every
     * ~3,840 events, and the barrier adds 10–27 ms per checkpoint on this Mac's
     * internal SSD and 211–281 ms on a USB enclosure. At the measured streaming
     * peak of 133 deltas/s that is one checkpoint every ~29 s, so the worst disk
     * measured pays under 1% of the event loop for it. Frequency is the half
     * that was missing when this was written up, and it is the half that makes
     * the answer yes.
     */
    // BUSY TIMEOUT FIRST, and the order is the whole point. `journal_mode=WAL`
    // takes a brief exclusive lock, so it is the statement most likely to meet
    // another connection — and a pragma only governs the statements that follow
    // it. Setting the timeout last left the one statement that needs a retry
    // budget running without one: a second opener (the export script, a second
    // daemon) got SQLITE_BUSY instantly instead of waiting out the handful of
    // milliseconds the first connection needed to finish closing.
    //
    // `synchronous` AFTER `journal_mode`, and it is not decoration: entering WAL
    // resets the level to the build's `DEFAULT_WAL_SYNCHRONOUS` unless one has
    // been set, which is 1 under bun and 2 under node. Spelling it here is what
    // stops the shipped app paying an fsync per commit nobody asked it for.
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA checkpoint_fullfsync=ON;");
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
    /**
     * AND WHEN A SNOOZE ENDED — issues #490, #586. Additive for the reason above
     * and on the same terms: an older binary neither knows nor needs to know it
     * exists, and a row written by one simply has no wake recorded — which is
     * indistinguishable from a session that never slept, and is the safe
     * direction. The one it must not take is announcing a wake that did not
     * happen, and an absent column cannot.
     */
    for (const column of ["title TEXT", "branch TEXT", "woke_at INTEGER"]) {
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
    /**
     * ONE ROW PER ITEM, INSTEAD OF ONE BLOB PER SESSION — issue #658.
     *
     * `items.json` was re-serialised and re-stored WHOLE on every batch that
     * touched an item, so the cost of writing one item was proportional to how
     * many the session already held. Measured at the write seam: 25 items cost
     * 1.5 MiB of writes to build a 60 KiB document, 800 items cost 1.45 GiB to
     * build 1.9 MiB — an amplification factor that IS the item count. The file
     * on disk stayed at 8 MiB throughout, which is why no instrument watching
     * the file had ever seen it.
     *
     * A ROWID TABLE, NOT `WITHOUT ROWID`, and it was measured both ways: 1.70×
     * the blob at rest against 1.90×, for #646's reason on `events` — large
     * values spill harder out of a `WITHOUT ROWID` leaf.
     *
     * AND IT IS NOT FREE AT REST. The blob is one big TEXT that overflows
     * predictably; rows of ~2.3 KiB each keep ~1 KiB inline and spill the rest
     * into a 4 KiB overflow page, which on 4 KiB pages costs ~1.7× the blob for
     * Telar's item sizes. Dropping the secondary index changes that by 0.01×, so
     * it is page rounding rather than index overhead. The trade is deliberate:
     * a bounded one-time increase against an unbounded per-event write cost.
     *
     * `ord` IS FIRST-OPEN ORDER, held across updates, because that is what the
     * blob's array order was — the Map was built in insertion order and every
     * reader has been handed it that way since. `(session_id, run_id, ord)` is
     * the window's index: a snapshot chooses TURNS, and an item is wanted
     * exactly when its turn is.
     *
     * ADDITIVE, `user_version` STAYS AT 1, on the terms the two blocks above
     * argue — with one extra clause that matters more here. An older binary
     * does not know this table, so it would read a migrated session's items as
     * ABSENT rather than as stale. That is what the per-session marker is for:
     * see `itemsAreRows`. The blob and the rows are never both authoritative.
     */
    this.db.exec(`CREATE TABLE IF NOT EXISTS items (
        session_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        ord INTEGER NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY(session_id, item_id)
      );
      CREATE INDEX IF NOT EXISTS items_run ON items(session_id, run_id, ord);`);
    /**
     * WHAT THE TURN'S `usage.updated` ROWS ADDED UP TO — issue #697.
     *
     * ADDITIVE AND NULLABLE, on the terms the two blocks above already argue:
     * an older binary names the columns it knows in its INSERT, these default to
     * NULL, and NULL is the honest answer — "this turn has not been folded",
     * which is also what the fold itself seeks on.
     *
     * ══ WHY A SUM IS STORED AND THE LAST ROW IS STILL KEPT ══
     *
     * The two shipped drivers do not mean the same thing by a `usage.updated`.
     *
     *   - Claude restates: every assistant envelope emits one, every closing
     *     `message_delta` CORRECTS the envelope before it, and the `result`
     *     message carries what `driver.ts` calls "the authoritative total plus
     *     the price". The last row of a Claude turn IS the turn.
     *   - Codex does not: `codexUsage` reads `tokenUsage.last` — one call's
     *     tokens, "`last`, NEVER `total`" — so a Codex turn emits no total at
     *     all and the only way to recover one is to add the rows up. Keeping
     *     the last row there would replace the turn's spend with the last
     *     call's, permanently, and the journal is the only copy.
     *
     * SO THE FOLD RECORDS THE ARITHMETIC RATHER THAN PICKING A WINNER: the SUM
     * over the turn's rows and HOW MANY there were, beside a journal that still
     * holds the last row. On Codex the sum is the turn's spend. On Claude the
     * last row is, and the sum is the restatements added together — which is
     * why `usage_rows` is stored next to it rather than left to be guessed, and
     * why nothing here is called `total`. A reader that needs one number must
     * know which driver wrote the turn; the fold does not, and does not pretend
     * to. Issue #697 part B is where that gets an answer.
     *
     * NOT SUMMED, DELIBERATELY: `costUsd` (Claude carries the turn's price
     * forward onto several rows, so adding them repeats it, and Codex quotes no
     * price at all) and `contextUsed`/`contextMax` (occupancy, not a counter —
     * a window that fills and is compacted goes DOWN). All three stay on the
     * surviving row, where they already were and still mean what they say.
     */
    for (const column of [
      "usage_input INTEGER", "usage_output INTEGER", "usage_cache_read INTEGER",
      "usage_cache_create INTEGER", "usage_reasoning INTEGER", "usage_rows INTEGER",
    ]) {
      const name = column.split(" ")[0]!;
      if (!this.db.prepare("PRAGMA table_info(turn_summaries)").all().some((existing) => String(existing.name) === name))
        this.db.exec(`ALTER TABLE turn_summaries ADD COLUMN ${column}`);
    }
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
    atomicWrite(statePaths(root).executionStore, { version: 1, backend: "sqlite" });
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
      this.sweepJournal();
    }, RECEIPT_PRUNE_EVERY_MS);
    this.pruneTimer.unref?.();
    /**
     * THE FIRST COMPACTION IS OFF THE OPEN PATH, and that is a measurement
     * rather than a preference.
     *
     * Running it in the constructor took FIFTY-FOUR SECONDS on the owner's
     * gigabyte — a one-time cost, since the watermark means later sweeps see
     * only new turns, but one-time on the launch right after an update, which
     * is the worst possible moment to hold the daemon shut. It would also have
     * been a longer stall than the VACUUM this deliberately keeps off the same
     * path, which would have made the argument for the button incoherent.
     *
     * So the daemon opens, and the sweep starts a few seconds later against the
     * same single-writer database. It is transactional per session, so a turn
     * that arrives mid-sweep waits for one session's DELETE and not for the
     * backlog. `unref` for the same reason as the timers above: housekeeping is
     * never the reason a process stays up.
     */
    this.compactTimer = setTimeout(() => { this.sweepJournal(); }, options.compactAfterOpenMs ?? COMPACT_AFTER_OPEN_MS);
    this.compactTimer.unref?.();
  }

  /** The sweep as housekeeping runs it: never throwing, and saying what went
   *  once it has actually gone rather than promising it at open. */
  private sweepJournal(): void {
    if (this.closed) return;
    try {
      const swept = this.compactJournal();
      if (swept.deltas > 0 || swept.starts > 0) {
        this.housekeeping.journal = swept;
        this.onJournalCompacted?.(swept);
      }
    } catch { /* the next sweep covers whatever this one missed */ }
    // A SECOND `try`, NOT A SECOND STATEMENT IN THE FIRST — issue #697. The two
    // sweeps are independent (own watermark, own rows, own guard), and a
    // compaction that threw must not be the reason the fold never ran.
    try {
      const folded = this.foldJournalUsage();
      if (folded.turns > 0 || folded.refused > 0) this.housekeeping.usage = folded;
    } catch { /* as above */ }
    // AND A THIRD, for the same independence. Retention is the only one of the
    // three that can DELETE something a reader would miss, and it is the only
    // one that does nothing at all unless somebody configured it — so it must
    // not be the reason the two lossless sweeps stop running, and they must not
    // be the reason it never does.
    try { this.onRetentionSweep?.(); } catch { /* as above */ }
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
   * DROP THE JOURNAL ROWS A SETTLED TURN HAS SUPERSEDED — issue #646.
   *
   * `events` is 68% of a gigabyte database on the dogfood home and grows
   * ~35 MB a day with nothing bounding it. Most of that is not history: a
   * streamed item is journalled three ways over its life, and once the turn
   * that made it has ended, two of the three add nothing a reader can use.
   *
   *   - `content.delta` is the streaming increments. `journal.ts` folds them
   *     into `item.streamedText` for an item it has already seen, and the
   *     closing `item.completed` carries that same text in the item itself.
   *   - `item.started` is the same item with `status: "inProgress"`. The
   *     completed event carries the same id, the same `startedAt`, and the
   *     final detail; both go through one `upsert` in the fold.
   *
   * Measured on the owner's store: 443,738 deltas and 127,213 `item.started`
   * rows qualified — 57% of a million-row journal — and the file went from
   * 1005.6 MiB to 695.1 MiB once a VACUUM returned the pages.
   *
   * ══ THE GUARD IS THE WHOLE DESIGN, AND IT IS NOT AN OPTIMISATION ══
   *
   * A delta is dropped ONLY where its item's own `item.completed` text is at
   * least as long as the deltas summed. That comparison is what makes the
   * deletion LOSSLESS BY CONSTRUCTION rather than by belief: where the claim
   * "the completed item already holds this text" is true the sum proves it,
   * and where it is false the rows stay and nothing is lost.
   *
   * It is not a formality. Sampling 4,000 items on the owner's store, 3,991
   * passed and NINE DID NOT — items whose completed text was shorter than what
   * was streamed into them. Those nine are the reason this is written as a
   * comparison and not as `WHERE type='content.delta'`. Do not simplify it
   * into the unconditional delete it looks like it wants to be: the 99.8% is
   * the argument FOR the guard, not against it.
   *
   * ══ WHY IT ONLY LOOKS BELOW A TERMINAL TURN EVENT ══
   *
   * An item belongs to a turn, so a turn that has ended is a range in which
   * every item is final. Bounding the sweep at the last terminal turn event
   * keeps it off anything in flight without needing to know what is running:
   * a delta still streaming has no `item.completed` to be measured against,
   * and a turn that died mid-item keeps its deltas, which are then the only
   * record of that text. The lower bound is the previous sweep's watermark,
   * so each event is examined once in its life rather than daily forever.
   *
   * ONE TRANSACTION PER SESSION, not one for the store. The first sweep on a
   * year-old store is most of the work this will ever do — around a minute
   * over the owner's 446 sessions, against 0.13 s for every sweep after it —
   * and holding a write lock across a million rows for that long would stall
   * the streaming path behind housekeeping. Per session
   * it is a fraction of a second, so a turn arriving mid-sweep waits for one
   * session's DELETE rather than for the backlog. That length is also why the
   * constructor no longer calls this; see the timer it arms instead.
   *
   * Returns what went, so the daemon can say it and a test can hold it to it.
   */
  compactJournal(): { deltas: number; starts: number; sessions: number } {
    const total = { deltas: 0, starts: 0, sessions: 0 };
    for (const sessionId of this.sessionIds()) {
      const swept = this.compactSession(sessionId);
      if (swept.deltas === 0 && swept.starts === 0) continue;
      total.deltas += swept.deltas;
      total.starts += swept.starts;
      total.sessions += 1;
    }
    return total;
  }

  /** One session's share of `compactJournal`, in a transaction of its own. */
  private compactSession(sessionId: string): { deltas: number; starts: number } {
    const swept = { deltas: 0, starts: 0 };
    this.alone(() => {
      // Held deltas belong in the database before anything sums them: a delta
      // still in the buffer makes its item's total look shorter than it is,
      // and the guard would pass on a comparison that is not yet true.
      this.drain(this.depth > 0);
      const key = `${COMPACT_WATERMARK_PREFIX}${sessionId}`;
      const stored = this.statement("SELECT value FROM metadata WHERE key=?").get(key);
      const low = Number(stored?.value ?? 0);
      const placeholders = TERMINAL_TURN_TYPES.map(() => "?").join(",");
      const high = Number(
        this.statement(
          `SELECT COALESCE(MAX(id),0) AS id FROM events WHERE session_id=? AND json_extract(value,'$.type') IN (${placeholders})`,
        ).get(sessionId, ...TERMINAL_TURN_TYPES)?.id ?? 0,
      );
      // No turn has ended here since the last sweep. Nothing below `low` can
      // have become compactable, so there is nothing to look at.
      if (high <= low) return;
      /**
       * THE SUM AGAINST THE COMPLETED TEXT, both bounded to the settled range.
       *
       * The bounds are on the completed side too, not only the deltas: an item
       * whose turn has not ended yet must not authorise dropping anything, and
       * leaving that subquery unbounded would let a later turn's completion
       * speak for an item that is still open.
       */
      this.statement(
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
      swept.deltas = Number(this.statement("SELECT changes() AS count").get()?.count ?? 0);
      // An `item.started` whose item never completed is kept for the same
      // reason its deltas are: it is the only row that item has.
      this.statement(
        `DELETE FROM events WHERE session_id=? AND id>? AND id<=?
           AND json_extract(value,'$.type')='item.started'
           AND json_extract(value,'$.item.id') IN (
             SELECT json_extract(value,'$.item.id') FROM events
              WHERE session_id=? AND id>? AND id<=? AND json_extract(value,'$.type')='item.completed')`,
      ).run(sessionId, low, high, sessionId, low, high);
      swept.starts = Number(this.statement("SELECT changes() AS count").get()?.count ?? 0);
      this.statement("INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(key, String(high));
    });
    return swept;
  }

  /**
   * FOLD A SETTLED TURN'S `usage.updated` ROWS INTO ONE AGGREGATE — issue #697.
   *
   * A token count is restated after every item, so a turn leaves behind as many
   * of these as it had envelopes. Measured on the owner's store (#646): 281k
   * rows across `usage.updated` and its neighbour, ~106 MB of a journal that is
   * 68% of the database. Unlike a delta, none of it is text a reader will ever
   * scroll past — the transcript takes the last one and the meter reads the
   * tail, so every row but the last is superseded the instant the next arrives.
   *
   * ══ WHY THE ROWS CANNOT SIMPLY GO ══
   *
   * See the columns this writes into for the long version. Short: on Codex each
   * row is ONE CALL's tokens and no turn total is ever emitted, so keeping the
   * last row and dropping the rest would destroy the turn's spend and leave the
   * last call's in its place. So the sum is written down BEFORE anything is
   * deleted, and the delete is refused for any turn that cannot hold it.
   *
   * ══ THE TWO THINGS THAT WOULD REFUSE THE DELETION ══
   *
   * 1. SUM CONSERVATION, checked inside the transaction and against a second,
   *    independent computation: the aggregate is folded in TypeScript over the
   *    parsed rows, sqlite sums the same range with `SUM(json_extract(...))`,
   *    and the two must agree field by field and on the row count. An
   *    implementation that recorded the SURVIVOR instead of the total fails
   *    this on any turn whose rows are not monotonic — which is every
   *    multi-call Codex turn. A disagreement throws, so `alone` rolls the whole
   *    session's fold back and the rows are still there.
   * 2. A PLACE TO PUT IT. A turn with no `turn_summaries` row has nowhere to
   *    record the sum, so its rows stay and it is counted as `refused` rather
   *    than quietly skipped.
   *
   * IDEMPOTENT BY SEEKING ON `usage_rows IS NULL` as well as by watermark. The
   * watermark is the cheap half — it keeps the daily sweep off a settled
   * journal — but a turn folded twice would sum a set of rows one delete had
   * already shrunk and overwrite a right answer with a wrong one, and a
   * watermark is not a strong enough thing to hang that on.
   *
   * SAME BOUNDS AS `compactSession`, for its reasons: one transaction per
   * session, and nothing above the session's last terminal turn event, so a
   * turn in flight is untouched without the sweep needing to know what is
   * running. Its own watermark, for the reason `USAGE_WATERMARK_PREFIX` gives.
   */
  foldJournalUsage(): { rows: number; turns: number; sessions: number; refused: number } {
    const total = { rows: 0, turns: 0, sessions: 0, refused: 0 };
    for (const sessionId of this.sessionIds()) {
      let folded: { rows: number; turns: number; refused: number };
      try {
        folded = this.foldUsage(sessionId);
      } catch {
        // The conservation check rolled this session back. One session's
        // refusal must not stop the rest from folding; it is counted instead.
        total.refused += 1;
        continue;
      }
      total.refused += folded.refused;
      if (folded.turns === 0) continue;
      total.rows += folded.rows;
      total.turns += folded.turns;
      total.sessions += 1;
    }
    return total;
  }

  /** One session's share of `foldJournalUsage`, in a transaction of its own.
   *  `rows` is what went; `turns` is what now has an aggregate. */
  foldUsage(sessionId: string): { rows: number; turns: number; refused: number } {
    const folded = { rows: 0, turns: 0, refused: 0 };
    this.alone(() => {
      // A held usage row belongs in the database before anything sums it, for
      // the reason `compactSession` drains: a row still in the buffer would be
      // absent from the sum and present in the journal afterwards.
      this.drain(this.depth > 0);
      const key = `${USAGE_WATERMARK_PREFIX}${sessionId}`;
      const low = Number(this.statement("SELECT value FROM metadata WHERE key=?").get(key)?.value ?? 0);
      const placeholders = TERMINAL_TURN_TYPES.map(() => "?").join(",");
      const high = Number(
        this.statement(
          `SELECT COALESCE(MAX(id),0) AS id FROM events WHERE session_id=? AND json_extract(value,'$.type') IN (${placeholders})`,
        ).get(sessionId, ...TERMINAL_TURN_TYPES)?.id ?? 0,
      );
      if (high <= low) return;
      /**
       * SQLITE'S OWN SUM over the range, per run — one half of the guard. The
       * other half is folded in TypeScript below from the parsed rows, and the
       * check is that two different computations of the same quantity agree.
       * Reading the same number twice the same way would prove nothing.
       */
      const runs = this.statement(
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
        /**
         * THE TURN HAS TO HAVE ENDED, and "below the session's last terminal
         * event" is not the same claim. A turn the daemon was killed in the
         * middle of leaves rows with no terminal event of their own; those are
         * the only account that turn has and they stay, exactly as an item that
         * never completed keeps its deltas.
         */
        const settled = this.statement(
          `SELECT 1 AS ok FROM events WHERE session_id=? AND id<=?
             AND json_extract(value,'$.runId')=? AND json_extract(value,'$.type') IN (${placeholders}) LIMIT 1`,
        ).get(sessionId, high, runId, ...TERMINAL_TURN_TYPES);
        if (!settled) continue;
        const summary = this.statement("SELECT usage_rows FROM turn_summaries WHERE session_id=? AND run_id=?")
          .get(sessionId, runId);
        // Already folded: leave it exactly alone. Summing again would add up a
        // set of rows the first fold has already shrunk.
        if (summary && summary.usage_rows !== null && summary.usage_rows !== undefined) continue;
        // Nowhere to record the sum, so nothing may be deleted. Counted rather
        // than skipped, because a store full of these is a store where the
        // projection needs backfilling, not one where the fold is done.
        if (!summary) { folded.refused += 1; continue; }

        const rows = this.statement(
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
        // ══ THE CONSERVATION CHECK ══ Nothing is deleted until this holds.
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
        this.statement(
          `DELETE FROM events WHERE session_id=? AND id>? AND id<=? AND id<>?
             AND json_extract(value,'$.type')='usage.updated' AND json_extract(value,'$.runId')=?`,
        ).run(sessionId, low, high, survivor, runId);
        const went = Number(this.statement("SELECT changes() AS count").get()?.count ?? 0);
        // The rows the arithmetic described are the rows that went, or the sum
        // above describes a journal that no longer exists.
        if (went !== rows.length - 1) throw new Error(`usage fold: ${went} rows went where ${rows.length - 1} were accounted for`);
        this.statement(
          `UPDATE turn_summaries SET usage_input=?, usage_output=?, usage_cache_read=?,
             usage_cache_create=?, usage_reasoning=?, usage_rows=? WHERE session_id=? AND run_id=?`,
        ).run(totals.input, totals.output, totals.cacheRead, totals.cacheCreate, totals.reasoning, rows.length, sessionId, runId);
        if (Number(this.statement("SELECT changes() AS count").get()?.count ?? 0) !== 1)
          throw new Error(`usage fold: the aggregate for ${sessionId}/${runId} was not recorded`);
        folded.rows += went;
        folded.turns += 1;
      }
      this.statement("INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(key, String(high));
    });
    return folded;
  }

  /** What one turn's `usage.updated` rows added up to, for a caller that wants
   *  the number without the rows. `undefined` until the fold has been here. */
  turnUsage(sessionId: string, runId: string): TurnUsageAggregate | undefined {
    const columns = this.statement(
      `SELECT usage_input, usage_output, usage_cache_read, usage_cache_create, usage_reasoning, usage_rows
         FROM turn_summaries WHERE session_id=? AND run_id=?`,
    ).get(sessionId, runId);
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

  /**
   * ══════════════ RETENTION — issues #542 and #646 ══════════════
   *
   * WHAT THIS IS AND IS NOT. It drops a settled session's raw `events` and
   * NOTHING ELSE. The five `documents` a session owns stay, and `session.json`
   * in particular is untouchable: `sessionIds()` reads the `sessions` table out
   * of that key, and `reconcileSessionRows` deletes every row it cannot find a
   * document for — so a sweep that took it would quietly remove the session
   * from the rail, from search and from the outline on the NEXT engine start,
   * with no error and no log line. That is the exact four things this promises
   * to keep, and it is why the range delete `deleteSession` uses is not reused
   * here.
   *
   * WHAT A PERSON LOSES is `sessions_read(mode: "events")`, `sessions_step` and
   * — the one the design's survives-list forgets — `sessions_grep`, which reads
   * raw event text. The transcript, the rail, `find`, the outline and the full
   * answer text are all backed by documents and `turn_summaries`, so none of
   * them moves.
   *
   * AND IT RETURNS NO BYTES ON ITS OWN. A DELETE moves pages to sqlite's
   * freelist; the file shrinks when somebody presses Reclaim. Said here because
   * the first run otherwise reports "freed 0 B" and reads as broken.
   */

  /** Every session row, archived included — `liveSessionRows` deliberately
   *  seeks past the archived ones, and an archived session is ELIGIBLE here. */
  private allSessionRows(): SessionIndexRow[] {
    return this.statement("SELECT * FROM sessions").all().map(rowFromColumns);
  }

  /**
   * WHICH SESSIONS A WINDOW WOULD TAKE — the one predicate, used by the preview
   * and by the sweep so the two cannot drift.
   *
   * ══ THE CLOCK IS `idleSince`, NOT "SETTLED" ══
   *
   * `settled_at` is stamped only by an EXPLICIT settle — a human pin or a
   * delegation settle — so a session shelved by the inactivity clock has none,
   * and a window keyed on it would skip nearly every session the rail calls
   * settled. Worse, "settled" is not a durable fact at all: it is a live
   * function of `autoSettleAfterHours`, a per-reader preference that accepts
   * `null` meaning *nothing ever ages out*. A person who turned that off would
   * enable retention and have it delete nothing, forever, with no explanation.
   *
   * So retention reads `idleSince()` — `max(updatedAt, readAt, snoozedUntil)`,
   * the clock's own baseline, present on every row — against its OWN window.
   * That also gives it the behaviour a person would expect for free: opening a
   * session resets its retention age, because `readAt` is a human's read
   * receipt and is not stamped by an agent calling `sessions_read`.
   *
   * ══ THE EXEMPTIONS ARE `isShelved`'s, BY CALLING IT ══
   *
   * A retention sweep with its own opinion about what may be shelved would be a
   * third dialect beside the engine's and the cockpit's. So this calls the
   * shared function — with its window set to ZERO, which neutralises the clause
   * retention is replacing and leaves exactly the guards that sit ABOVE the
   * clock: a live turn, a parked request, `settledOverride: "active"`, a live
   * snooze, an unread result, and a draft. An archived session is not exempt;
   * `isSettled` shelves it outright, which is the intended answer here.
   */
  private retirable(window: { idleBefore: number; now: number }): SessionIndexRow[] {
    return this.allSessionRows().filter(
      (row) =>
        idleSince(row) < window.idleBefore &&
        isShelved({ ...row }, settlingActivityOf(row), { now: window.now, autoSettleAfterHours: 0 }),
    );
  }

  /**
   * WHAT A WINDOW WOULD TAKE, WITHOUT TAKING IT — issue #542, step 1.
   *
   * COUNTS ARE CHEAP AND BYTES ARE NOT, and the shape says so. Rows per session
   * is a range on the `events` primary key `(session_id, id)`;
   * `SUM(LENGTH(value))` has to read the rows themselves, which on a gigabyte
   * is a real scan. So bytes are an explicit ask and never on a polling path
   * (#629 is open because four timers in the rail cost ~97,000 requests a day).
   *
   * THE PREVIEW AND THE SWEEP ARE ONE QUERY, which is the property worth
   * protecting: a preview computed separately from the sweep is a number that
   * will drift and be believed. Both go through `retirable` above.
   */
  retentionPreview(window: { idleBefore: number; now: number }, options: { bytes?: boolean } = {}): { sessions: number; events: number; bytes?: number } {
    const rows = this.retirable(window);
    let events = 0;
    let bytes = 0;
    for (const row of rows) {
      events += Number(this.statement("SELECT COUNT(*) AS count FROM events WHERE session_id=?").get(row.id)?.count ?? 0);
      if (options.bytes)
        bytes += Number(this.statement("SELECT COALESCE(SUM(LENGTH(CAST(value AS BLOB))),0) AS bytes FROM events WHERE session_id=?").get(row.id)?.bytes ?? 0);
    }
    return { sessions: rows.length, events, ...(options.bytes ? { bytes } : {}) };
  }

  /**
   * ONE SESSION, WRITTEN OUT IN `exportLegacy`'s SHAPE — issue #542, step 2.
   *
   * The format is not invented here: `exportLegacy` already writes a store as
   * its documents plus `sessions/<id>/events.ndjson`, skips the derived
   * `.index.json` files, and refuses a destination that exists. This is that,
   * for one session, so a caller gets the same directory a whole-store export
   * would have produced.
   *
   * PAGED, AND THAT IS THE POINT. `exportLegacy` calls `this.events(id)`
   * UNBOUNDED, materialising every event of a session as one JS array — fine
   * for a migration escape hatch, not fine for the path retention is about to
   * make load-bearing on a 62,000-event session. This uses the bounded
   * `events(id, after, limit)` and appends, so resident memory is one page.
   *
   * RETURNS THE LINE COUNT, because that is what the retirement guard compares
   * against the rows it is about to delete. A number, not a promise.
   *
   * `mode: 0o700` IS IGNORED ON WINDOWS, so an export of raw conversation
   * history there inherits the parent directory's ACL. The flow that calls this
   * should say where it is putting it rather than pretend otherwise.
   */
  exportSession(sessionId: string, destination: string): { documents: number; events: number } {
    if (fs.existsSync(destination)) throw new Error("Export destination must not already exist");
    // Held deltas belong in the database before anything reads them out: an
    // export short by the tail is an export the retirement guard would refuse,
    // which is the safe direction but the wrong answer.
    this.flush();
    const directory = path.join(destination, "sessions", sessionId);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const [low, high] = prefixRange(`sessions/${sessionId}/`);
    let documents = 0;
    for (const row of this.statement("SELECT key,value FROM documents WHERE key >= ? AND key < ? ORDER BY key").all(low, high)) {
      // The offset indexes describe THIS store's compact text and an export
      // pretty-prints, so carrying them over would ship offsets into bytes the
      // exported file does not have. Derived: the next write rebuilds them.
      if (String(row.key).endsWith(".index.json")) continue;
      atomicWrite(path.join(destination, String(row.key)), JSON.parse(String(row.value)));
      documents += 1;
    }
    /**
     * AND THE ITEMS, WHEREVER #658 PUT THEM. A migrated session has no
     * `items.json` row to have been copied above — its items are rows — so an
     * export that only walked `documents` would write a session directory with
     * the conversation's own item projection missing, silently, and only for
     * sessions that had been migrated. Written back in the blob's shape,
     * which is the shape `exportLegacy` has always produced and the one an
     * older build could read.
     */
    if (this.itemsAreRows(sessionId)) {
      const rows = this.itemRows(sessionId);
      fs.writeFileSync(path.join(directory, "items.json"), `{"items":[${rows.join(",")}]}`, { mode: 0o600 });
      documents += 1;
    }
    const file = path.join(directory, "events.ndjson");
    const handle = fs.openSync(file, "w", 0o600);
    let events = 0;
    try {
      let after = 0;
      for (;;) {
        const page = this.events(sessionId, after, EXPORT_PAGE);
        if (page.length === 0) break;
        fs.writeSync(handle, page.map((event) => `${JSON.stringify(event)}\n`).join(""));
        events += page.length;
        after = page[page.length - 1]!.id;
        if (page.length < EXPORT_PAGE) break;
      }
    } finally { fs.closeSync(handle); }
    return { documents, events };
  }

  /**
   * DROP ONE SETTLED SESSION'S JOURNAL, AFTER PROVING THE TIER THAT SURVIVES IT
   * ACTUALLY HOLDS THE CONVERSATION — issues #542 and #646.
   *
   * ══ THREE REFUSALS, AND EACH ONE SKIPS RATHER THAN THROWS ══
   *
   * 1. THE SUMMARIES ARE ALL THERE. `COUNT(DISTINCT runId)` over the terminal
   *    turn events in the journal must equal the number of `turn_summaries`
   *    rows this session has in a terminal state. This is not a formality:
   *    `backfillTurnSummaries` SWALLOWS an unreadable queue and moves on, so a
   *    session whose summaries were never built is exactly the case that must
   *    not be swept — and it is invisible from anywhere else.
   * 2. `items.json` PARSES. The transcript is drawn from it; a session whose
   *    item projection is unreadable has nothing behind its summaries, and
   *    dropping its journal would leave a titled conversation with no turns in
   *    it and nothing able to rebuild them.
   * 3. THE EXPORT IS COMPLETE. The NDJSON line count must equal the row count
   *    about to be deleted, checked inside the transaction. This is the
   *    strongest "lossless by construction" available when the thing being
   *    dropped has no surviving copy to compare against: the export IS the copy
   *    and the count is the comparison. An export that came up short deletes
   *    nothing.
   *
   * A REFUSAL IS COUNTED, NEVER LOGGED. A retired session and a skipped one
   * print the same session id, so a grep keyed on it is satisfied by either —
   * which is the vacuous-guard shape this repository has already shipped once.
   * `{ retired, skipped, events }` distinguishes the states; a string does not.
   *
   * ONE TRANSACTION PER SESSION, reusing `compactSession`'s argument verbatim:
   * the first run after enabling is the whole backlog, and a single transaction
   * across it would stall the streaming path behind housekeeping.
   */
  retireSession(sessionId: string, options: { exportTo: string }): { retired: boolean; events: number; refused?: "summaries" | "items" | "export" } {
    const held = Number(this.statement("SELECT COUNT(*) AS count FROM events WHERE session_id=?").get(sessionId)?.count ?? 0);
    // Already empty — retired by an earlier sweep, or a session that never
    // journalled. Nothing to do and nothing to refuse.
    if (held === 0 && this.held().every((event) => event.sessionId !== sessionId)) return { retired: false, events: 0 };

    const summaries = this.turnSummaryStates(sessionId).filter((row) => (TERMINAL_TURN_STATES as readonly string[]).includes(row.state)).length;
    const placeholders = TERMINAL_TURN_TYPES.map(() => "?").join(",");
    const ended = Number(
      this.statement(
        `SELECT COUNT(DISTINCT json_extract(value,'$.runId')) AS count FROM events
          WHERE session_id=? AND json_extract(value,'$.type') IN (${placeholders})`,
      ).get(sessionId, ...TERMINAL_TURN_TYPES)?.count ?? 0,
    );
    if (summaries !== ended) return { retired: false, events: 0, refused: "summaries" };
    try {
      /**
       * WHEREVER #658 PUT THEM. A session's items are a blob or a table of
       * rows, and `itemsAreRows` is the only thing that decides which — never
       * the presence of the document, which cannot tell "migrated, blob
       * deleted" from "never written". Asking the wrong side would refuse every
       * migrated session forever, or pass every one of them without looking.
       *
       * Either way the question is the same and it is asked in sqlite:
       * `json_valid` over the rows, `json_array_length` over the blob. An
       * `items.json` has been measured at 17 MiB, and parsing it in JavaScript
       * to learn whether it parses is the cost this guard must not have.
       */
      const readable = this.itemsAreRows(sessionId)
        ? this.statement("SELECT COUNT(*) AS bad FROM items WHERE session_id=? AND json_valid(value)=0").get(sessionId)?.bad === 0
        : (() => {
            const blob = this.statement("SELECT json_array_length(value,'$.items') AS count FROM documents WHERE key=?")
              .get(`sessions/${sessionId}/items.json`);
            // No document and no rows is a session that never wrote an item,
            // which is readable in the only sense that matters here.
            return blob === undefined || blob.count !== null;
          })();
      if (!readable) return { retired: false, events: 0, refused: "items" };
    } catch { return { retired: false, events: 0, refused: "items" }; }

    /**
     * AN EXPORT THAT WILL NOT WRITE REFUSES THE SESSION, IT DOES NOT STOP THE
     * SWEEP. A document that no longer parses, a destination already there from
     * an interrupted run, a full disk — each of those is a reason to leave ONE
     * conversation exactly as it was, and none of them is a reason for the other
     * four hundred to go unswept. It is counted as a refusal, which is the same
     * signal every other guard here produces.
     */
    let exported: { documents: number; events: number };
    try {
      exported = this.exportSession(sessionId, path.join(options.exportTo, sessionId));
    } catch { return { retired: false, events: 0, refused: "export" }; }
    let outcome: { retired: boolean; events: number; refused?: "export" } = { retired: false, events: 0, refused: "export" };
    this.alone(() => {
      this.drain(this.depth > 0);
      const rows = Number(this.statement("SELECT COUNT(*) AS count FROM events WHERE session_id=?").get(sessionId)?.count ?? 0);
      // A turn that landed between the export and here makes the copy short.
      // Refuse and leave it: the next sweep exports again.
      if (rows !== exported.events) return;
      const high = Number(this.statement("SELECT COALESCE(MAX(id),0) AS id FROM events WHERE session_id=?").get(sessionId)?.id ?? 0);
      this.statement("DELETE FROM events WHERE session_id=?").run(sessionId);
      // IN THE SAME TRANSACTION AS THE DELETE — see `JOURNAL_FLOOR_PREFIX`.
      // Written unconditionally rather than only when the journal is emptied,
      // because this delete always empties it.
      this.statement("INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(`${JOURNAL_FLOOR_PREFIX}${sessionId}`, String(Math.max(high, this.cursors.get(sessionId) ?? 0)));
      outcome = { retired: true, events: rows };
    });
    return outcome;
  }

  /**
   * THE SWEEP — every session a window takes, one transaction each.
   *
   * ON THE EXISTING HOUSEKEEPING CADENCE AND NEVER ON THE OPEN PATH. #661
   * measured the first compaction at 54 seconds when it ran in the constructor,
   * and a retention backlog is larger work than a compaction backlog. The first
   * run after somebody enables this is a distinct visible act with a count in
   * front of it, not something the next startup does quietly.
   */
  retireJournal(window: { idleBefore: number; now: number }, options: { exportTo: string }): { retired: number; skipped: number; events: number } {
    const total = { retired: 0, skipped: 0, events: 0 };
    for (const row of this.retirable(window)) {
      const went = this.retireSession(row.id, options);
      if (went.retired) { total.retired += 1; total.events += went.events; }
      else if (went.refused) total.skipped += 1;
    }
    return total;
  }

  /** The database and the files sqlite keeps beside it, as they are right now. */
  private journalBytes(): number {
    const file = path.join(this.root, "execution.sqlite");
    let bytes = 0;
    for (const name of [file, `${file}-wal`, `${file}-shm`]) {
      try { bytes += fs.statSync(name).size; } catch { /* -wal and -shm need not exist */ }
    }
    return bytes;
  }

  /**
   * GIVE THE FREED PAGES BACK TO THE FILESYSTEM — issue #646, and ONLY on ask.
   *
   * A `DELETE` moves pages to sqlite's freelist, where later inserts reuse
   * them; the file itself never shrinks. So `compactJournal` above makes the
   * database hold less without making it WEIGH less, and this is the half that
   * finishes the job. Measured on the owner's store: the compaction dropped
   * 570,951 rows and left the file at 1005.6 MiB to the byte, and the VACUUM
   * after it brought it to 695.1 MiB.
   *
   * ══ WHY THIS IS A BUTTON AND NOT PART OF THE OPEN ══
   *
   * `VACUUM` rewrites the entire database under an exclusive lock and needs
   * free space about equal to its own size. On the owner's gigabyte, in place
   * and through the WAL, that measured at 20–35 SECONDS across runs.
   * (`VACUUM INTO` a fresh file on the same machine is 7 s — worth knowing,
   * because that is the figure a quick experiment produces and it is not the
   * one this path pays. Anyone re-measuring this should measure the real
   * thing.) Half a minute of a Telar that looks hung, on every launch, to
   * return space that accrues over a month, is not a trade worth making for
   * somebody. A person who wants the bytes back asks for them.
   *
   * ON ITS OWN IT IS ALMOST NOTHING. Vacuuming this database WITHOUT compacting
   * it first returned 22.5 MiB of 1005.6 — 2.2%, because the freelist was only
   * 1.7% of the file. That is why this compacts first and reports one number:
   * the VACUUM is not the fix, it is what makes the fix visible.
   *
   * Returns the size either side of the work, because the difference is the
   * whole point of the button — and because it is also how a person learns that
   * pressing it again tomorrow will do nothing.
   */
  reclaim(): { before: number; after: number; deltas: number; starts: number; sessions: number; usage: number } {
    const before = this.journalBytes();
    const journal = this.compactJournal();
    // The usage fold rides the same press for the reason the compaction does:
    // its DELETEs return no bytes either, and the VACUUM below is the only
    // thing that turns either sweep into a smaller file.
    const usage = this.foldJournalUsage();
    // Everything held must be on disk before the rewrite: VACUUM cannot run
    // inside a transaction, so there is no scope here to carry them into.
    this.flush();
    /**
     * `wal_checkpoint(TRUNCATE)` FIRST, for a reason that is not the bytes.
     *
     * The WAL is a high-water mark — 24.3 MiB on the owner's machine holding
     * 2.67 MiB of live frames — and that is only 2% of the problem, which is
     * why nothing else here touches it. But a VACUUM's rewrite lands in the WAL
     * before it lands in the database, and starting it against a WAL already
     * carrying a burst is how a 7-second rewrite becomes a longer one.
     */
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.db.exec("VACUUM");
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return { before, after: this.journalBytes(), ...journal, usage: usage.rows };
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
   * ══ ITEMS AS ROWS — issue #658 ══
   *
   * The six methods below are the whole of the row shape's surface. Everything
   * above them still speaks in documents, and a session that has not migrated
   * still IS a document; `itemsAreRows` is the only thing that decides which.
   */

  /** Does this session hold its items as rows rather than as a blob? The one
   *  question the read path asks first — never inferred from a missing
   *  document, which cannot tell a migrated session from an empty one. */
  itemsAreRows(sessionId: string): boolean {
    return this.statement("SELECT 1 FROM metadata WHERE key=? LIMIT 1").get(`${ITEMS_ROWS_PREFIX}${sessionId}`) != null;
  }

  /**
   * MOVE ONE SESSION'S ITEMS FROM THE BLOB TO ROWS — ALL OF IT, OR NONE.
   *
   * The rows, the deleted documents and the marker commit TOGETHER. This is the
   * safety property, and the tidier-looking variant is the one that loses a
   * projection: deleting the blob in a second transaction leaves a kill between
   * them with rows nobody will read (no marker) and no blob to read instead.
   *
   * `ord` is the caller's array order, which is the blob's array order, which is
   * the order every reader has been handed since items existed.
   *
   * `documents` are dropped by KEY rather than by prefix: the session's queue,
   * metadata and requests live under the same prefix and are not this issue's.
   */
  migrateItemsToRows(sessionId: string, rows: ReadonlyArray<{ id: string; runId: string; value: string }>, documents: string[]): void {
    this.alone(() => {
      const insert = this.statement("INSERT INTO items(session_id,item_id,run_id,ord,value) VALUES(?,?,?,?,?) "
        + "ON CONFLICT(session_id,item_id) DO UPDATE SET run_id=excluded.run_id, value=excluded.value");
      rows.forEach((row, at) => insert.run(sessionId, row.id, row.runId, at + 1, row.value));
      for (const key of documents) this.statement("DELETE FROM documents WHERE key=?").run(path.relative(this.root, key));
      this.statement("INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(`${ITEMS_ROWS_PREFIX}${sessionId}`, String(rows.length));
    });
  }

  /**
   * Write the items a batch actually touched, and nothing else.
   *
   * `ord` is assigned on FIRST insert and held across every update after it —
   * an item that completes does not jump to the end of its own conversation.
   * The subquery is evaluated before the row lands, so several new items in one
   * call still take consecutive positions.
   */
  upsertItems(sessionId: string, rows: ReadonlyArray<{ id: string; runId: string; value: string }>): void {
    if (rows.length === 0) return;
    const insert = this.statement("INSERT INTO items(session_id,item_id,run_id,ord,value) "
      + "VALUES(?,?,?,(SELECT COALESCE(MAX(ord),0)+1 FROM items WHERE session_id=?),?) "
      + "ON CONFLICT(session_id,item_id) DO UPDATE SET run_id=excluded.run_id, value=excluded.value");
    for (const row of rows) insert.run(sessionId, row.id, row.runId, sessionId, row.value);
  }

  /** DOES THIS ITEM EXIST — the streaming path's one question, answered by the
   *  primary key rather than by materialising a projection to ask a Map. */
  hasItemRow(sessionId: string, itemId: string): boolean {
    return this.statement("SELECT 1 FROM items WHERE session_id=? AND item_id=? LIMIT 1").get(sessionId, itemId) != null;
  }

  /** Every item of a session, in first-open order — the blob's order. */
  itemRows(sessionId: string): string[] {
    return this.statement("SELECT value FROM items WHERE session_id=? ORDER BY ord").all(sessionId).map((row) => String(row.value));
  }

  /**
   * The items filed under `runIds`, in order — what a WINDOW wants, and the
   * reason `items_run` exists. This is what replaces the offset index: the
   * window's rows are chosen by the database rather than by a byte range
   * computed over the whole document on every write.
   *
   * An empty set is an empty answer rather than an unbounded `IN ()`.
   *
   * THE SET RIDES AS JSON, not as `IN (?,?,?)` built per call. `statement()`
   * caches by SQL text and never evicts, so a placeholder list that varies with
   * the window would leave one prepared statement per distinct window size in
   * the cache for the life of the daemon. `json_each` keeps the text constant
   * and the arity free; the two existing dynamic `IN`s in this file get away
   * with interpolation only because their length is a compile-time constant.
   */
  itemRowsForRuns(sessionId: string, runIds: readonly string[]): string[] {
    if (runIds.length === 0) return [];
    return this.statement("SELECT value FROM items WHERE session_id=? AND run_id IN (SELECT value FROM json_each(?)) ORDER BY ord")
      .all(sessionId, JSON.stringify(runIds)).map((row) => String(row.value));
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
    const rows = Number(this.statement("SELECT COALESCE(MAX(id),0) AS id FROM events WHERE session_id=?").get(sessionId)?.id ?? 0);
    // THE MAX OF THE ROWS AND THE FLOOR — see `JOURNAL_FLOOR_PREFIX`. Retention
    // can empty a session's journal, and `MAX(id)` over no rows is 0: without
    // this the sequence restarts at 1 after the next restart and every client
    // holding an older cursor goes permanently deaf to that session.
    const floor = Number(this.statement("SELECT value FROM metadata WHERE key=?").get(`${JOURNAL_FLOOR_PREFIX}${sessionId}`)?.value ?? 0);
    const stored = Math.max(rows, Number.isFinite(floor) ? floor : 0);
    const head = this.held().reduce((highest, event) => event.sessionId === sessionId && event.id > highest ? event.id : highest, stored);
    this.cursors.set(sessionId, head);
    return head;
  }
  append(event: EngineEvent): void {
    this.cursors.set(event.sessionId, Math.max(event.id, this.cursors.get(event.sessionId) ?? 0));
    // A TURN THAT ENDED IS THE ONE QUIESCENCE POINT THIS STORE HAS — see
    // `barrier`. The last terminal event of the scope wins, because one barrier
    // persists everything committed before it on the same device; a scope that
    // ends two turns pays once, not twice.
    if ((TERMINAL_TURN_TYPES as readonly string[]).includes(event.type))
      this.barrierDue = { sessionId: event.sessionId, eventId: event.id };
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

  /**
   * EVERY ROW A WAKE COULD STILL BE OWED ON — issues #490, #586.
   *
   * THE NARROWING, NOT THE DECISION. `wokeAt()` in the protocol package is the
   * one implementation of "when did this conversation wake", and it reads fields
   * (`raisedHandWhileSnoozed`) whose rule has no business being restated in SQL
   * — a second copy in a dialect nobody tests against is how the two answers
   * drift. So this returns the rows the question can even be ASKED about and
   * lets the shared function answer it.
   *
   * THE PREDICATE IS THE WHOLE COST. A session with no snooze is not a row here,
   * and one whose wake is already recorded is not either — which on any real
   * store is all but a handful. That is why this sweep does NOT copy
   * `sweepDelegatedSettling`'s whole-store loop: that one walks `sessionIds()`
   * because its predicate lives in DOCUMENTS and SQL cannot see it. Ours is two
   * columns on the index, so walking every session to re-ask them would be a
   * pass this table exists to prevent. The next reader will assume the loop was
   * the pattern to follow; it was the constraint, not the pattern.
   *
   * ARCHIVED ROWS ARE NOT WOKEN. They are off every list by a decision that
   * outranks a snooze, so a wake announced on one is a notification about a
   * conversation the reader cannot see.
   */
  dueSnoozeWakes(): SessionIndexRow[] {
    return this.statement("SELECT * FROM sessions WHERE snoozed_until IS NOT NULL AND woke_at IS NULL AND archived = 0")
      .all()
      .map(rowFromColumns);
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
   * NEWEST ACTIVE SESSION PER PROJECT — one number each, and no session at all
   * (#490).
   *
   * The front door ranks projects by this and renders nothing from the rows it
   * used to rank from: `composerProject` folds every session into
   * `Map<projectId, max(updatedAt)>` and reads the top of it. On the owner's
   * store that fold cost 101.6 KB of serialised rows — titles, branches,
   * activity, every settling field — to produce roughly twenty integers. This
   * is the fold, done where the index is.
   *
   * WHICH INDEX SERVES IT, MEASURED RATHER THAN ASSUMED. `sessions_project` is
   * `(project_id, updated_at)` — exactly this aggregate's shape — but this
   * engine never runs `ANALYZE`, and with no statistics SQLite prefers the
   * `archived = 0` seek: `SEARCH sessions USING INDEX sessions_shelf
   * (archived=?)` then `USE TEMP B-TREE FOR GROUP BY`. Given statistics it
   * collapses to a single ordered walk of `sessions_project` and no sort at all.
   * Neither is worth an `INDEXED BY` here: both read scalars, the sort is over a
   * few hundred two-column rows, and the cost this replaces was never the query
   * — it was 291 documents folded and 101.6 KB serialised to a browser that
   * wanted one integer per project.
   *
   * `archived = 0` BECAUSE THE RANKING'S COLD CASE DEPENDS ON IT. The list this
   * replaces was `liveSessions`, which carries ACTIVE sessions only, and
   * `composerProject` leans on that: a project whose conversations are all
   * archived must score 0 and fall through to most-recently-registered rather
   * than win on work somebody finished with.
   *
   * A PROJECTLESS SESSION IS NOT A VOTE, so it is dropped here rather than
   * grouped under a null key. `composerProject` skips it too (`if
   * (!session.projectId) continue`); filtering in SQL keeps the answer from
   * carrying a row whose only possible effect is to be ignored.
   */
  projectActivity(): { projectId: string; updatedAt: number }[] {
    return this.statement(
      "SELECT project_id, MAX(updated_at) AS updated_at FROM sessions WHERE archived = 0 AND project_id IS NOT NULL GROUP BY project_id",
    ).all().map((row) => ({ projectId: String(row.project_id), updatedAt: Number(row.updated_at) }));
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
      // The compaction watermark goes with the events it describes; a row left
      // behind would outlive its session forever and, on a session id that
      // somehow came back, would skip the whole journal below it.
      this.statement("DELETE FROM metadata WHERE key=?").run(`${COMPACT_WATERMARK_PREFIX}${sessionId}`);
      this.statement("DELETE FROM metadata WHERE key=?").run(`${USAGE_WATERMARK_PREFIX}${sessionId}`);
      // The items and the marker that says where to look for them, together and
      // here — a marker left behind would tell a reused id its items are rows
      // when the rows went with the session, and that reads as an empty
      // conversation rather than as an error (#658).
      this.statement("DELETE FROM items WHERE session_id=?").run(sessionId);
      this.statement("DELETE FROM metadata WHERE key=?").run(`${ITEMS_ROWS_PREFIX}${sessionId}`);
      // And the retention floor, for the same reason: it describes a journal
      // that no longer exists, and on a session id that somehow came back it
      // would start the sequence above every event that session ever has.
      this.statement("DELETE FROM metadata WHERE key=?").run(`${JOURNAL_FLOOR_PREFIX}${sessionId}`);
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
      this.barrierDue = undefined;
      throw error;
    } finally { this.depth -= 1; }
    this.maybeBarrier();
  }

  /**
   * ONE DEVICE BARRIER PER SETTLED TURN — issue #632, change 3.
   *
   * ══ WHY IT IS A SECOND COMMIT AND NOT A PRAGMA AROUND THE FIRST ══
   *
   * The design this comes from says to raise `synchronous=FULL` immediately
   * before the turn's own `COMMIT` and restore it after. **Sqlite refuses**:
   * `PRAGMA synchronous` inside an open transaction throws "Safety level may
   * not be changed inside a transaction", on both runtimes. And the flag this
   * reads is only known once `operation()` has run, which is after `BEGIN` — so
   * there is no moment at which the intended spelling is legal.
   *
   * What is legal, and is what the guarantee actually needs, is the amortised
   * pattern `fcntl(2)` documents in so many words: *"as this drains the entire
   * queue of the device and acts as a barrier, data that had been fsync'd on
   * the same device before is guaranteed to be persisted when this call
   * returns."* So the turn commits at NORMAL, and a second, one-row commit at
   * `FULL` + `fullfsync=ON` immediately after is the barrier for it and for
   * every delta underneath it. Measured (`bench:durability`, `node:sqlite`):
   * 78–82 ms per barrier on a USB enclosure, once per turn, against turns
   * measured in seconds to minutes.
   *
   * ══ BEFORE THE DAEMON ANSWERS ══
   *
   * This runs inside `transaction()`, before it returns — so the reply that
   * says a turn completed goes out after the barrier, not before it. That is
   * the ordering choice, and it is the one that lets Telar mean "on the
   * platter" when it says a turn is settled. It is also why nothing here is a
   * setting: a barrier the person can turn off is a claim that is sometimes
   * true.
   *
   * ══ WHAT IT DOES NOT CLAIM ══
   *
   * That the drive obeyed. `fcntl(2)` is explicit that some drives ignore the
   * request. The claim is exactly: Telar issued the call Apple documents as
   * flushing the drive's cache, and issued it before acknowledging the turn.
   *
   * A FAILURE HERE DOES NOT FAIL THE TURN. The transaction is already
   * committed; throwing now would report a command as failed that succeeded.
   * What a failure costs is the stronger guarantee, leaving the NORMAL one the
   * store had before — and it is uncounted, so a test asserting the count
   * cannot mistake it for success.
   */
  private maybeBarrier(): void {
    const due = this.barrierDue;
    this.barrierDue = undefined;
    if (!due || this.closed) return;
    try {
      this.db.exec("PRAGMA synchronous=FULL; PRAGMA fullfsync=ON;");
      try {
        this.db.exec("BEGIN IMMEDIATE");
        try {
          this.statement("INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
            .run(DURABILITY_BARRIER_KEY, `${due.sessionId}:${due.eventId}`);
          this.db.exec("COMMIT");
        } catch (error) { this.db.exec("ROLLBACK"); throw error; }
      } finally { this.db.exec("PRAGMA synchronous=NORMAL; PRAGMA fullfsync=OFF;"); }
    } catch { return; }
    this.onDurabilityBarrier?.(due);
  }

  /**
   * THE DURABILITY PRAGMAS IN EFFECT ON THIS CONNECTION, READ BACK — #632.
   *
   * A pragma is per connection, so nothing outside this object can observe the
   * ones it set: a test that opened the same file would be asserting about its
   * own connection's defaults. This is the only honest way to hold the
   * constructor to what its comment says, and it answers with VALUES because
   * the alternative — grepping the source for the pragma text — passes on a
   * line that was never executed.
   *
   * NOTE WHAT IT CANNOT PROVE. Under `bun:sqlite` `checkpoint_fullfsync` is
   * already 1 before anything sets it, so an assertion here is vacuous for the
   * packaged app, which runs `node:sqlite` where the default is 0. That gap is
   * what `scripts/durability-pragmas.mjs` exists to close.
   */
  durabilityPragmas(): { synchronous: number; checkpointFullfsync: number; fullfsync: number } {
    const read = (name: string): number => Number(Object.values(this.db.prepare(`PRAGMA ${name}`).get() ?? {})[0] ?? 0);
    return { synchronous: read("synchronous"), checkpointFullfsync: read("checkpoint_fullfsync"), fullfsync: read("fullfsync") };
  }

  /** `<sessionId>:<eventId>` of the last turn a device barrier persisted, or
   *  `undefined` on a store no turn has ended on. See `DURABILITY_BARRIER_KEY`:
   *  it is the barrier's own write, so its presence is the evidence that the
   *  barrier's commit produced a WAL frame to sync rather than nothing. */
  barrierWatermark(): string | undefined {
    const row = this.statement("SELECT value FROM metadata WHERE key=?").get(DURABILITY_BARRIER_KEY);
    return row ? String(row.value) : undefined;
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
    /** Assigned by every path that reaches the barrier below; the catch throws
     *  and the replay returns, so the two paths that skip it never read it. */
    let settled!: T;
    try {
      // A receipt id this call just minted cannot already be on file, so the
      // lookup is skipped entirely unless a CALLER supplied the id — which is
      // the only case where a replay is possible.
      const known = commandId === undefined ? undefined : this.statement("SELECT command,result FROM receipts WHERE id=?").get(receiptId);
      if (known) {
        if (known.command !== command) throw new Error("command id was already used for a different command");
        this.db.exec("COMMIT");
        // NO BARRIER ON A REPLAY, and it is not an oversight: `operation` never
        // ran, so nothing was appended and the turn this is re-answering was
        // barriered when it actually happened.
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
      settled = result;
    } catch (error) { this.db.exec("ROLLBACK"); this.revert(); throw error; }
    finally { this.depth -= 1; }
    // OUTSIDE THE TRANSACTION AND BEFORE THE RETURN — the barrier needs the
    // first because sqlite refuses its pragmas inside one, and the second
    // because the point is that the daemon answers after it. See `maybeBarrier`.
    this.maybeBarrier();
    return settled;
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
    // A turn that rolled back did not settle, so there is nothing to persist
    // and nothing to claim: see `barrierDue`.
    this.barrierDue = undefined;
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
    if (this.compactTimer) { clearTimeout(this.compactTimer); this.compactTimer = undefined; }
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
      // THROUGH `statePaths`, LIKE EVERY OTHER ROOT-LEVEL NAME (#665). These
      // two were joined by hand here, which is the second way of naming a
      // store-root file that the invariant test's allowlist cannot see.
      for (const file of [statePaths(this.root).taskStops, statePaths(this.root).subscriptions]) {
        if (fs.existsSync(file)) {
          // Made here rather than up front, for the reason stated above: the
          // per-session copies make their own parents, and this is the only
          // other thing that ever goes in.
          fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
          const copy = path.join(backup, path.basename(file));
          if (!fs.existsSync(copy)) fs.copyFileSync(file, copy, fs.constants.COPYFILE_EXCL);
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
