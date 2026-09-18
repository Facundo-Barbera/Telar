/**
 * ONE CONVERSATION, NOT A THOUSAND COPIES OF IT — checkpoint retention (#599).
 *
 * ── THE MEASUREMENT THIS FILE EXISTS FOR ────────────────────────────────────
 * On the dogfood Mac, `agent/threads.sqlite` was 1.53 GB for a conversation
 * that is 1.9 MB of text. 993 rows in `checkpoints`, 1,459 MB of `checkpoint`
 * blob, mean 1,504 KB each, max 3,245 KB. The readable transcript beside them —
 * `agent_rows` plus its FTS index — was under 5 MB.
 *
 * So the store held roughly 990 COMPLETE COPIES of one conversation, and grew
 * quadratically: `SqliteSaver.put` writes a full snapshot of the entire message
 * list at every superstep, one turn is a dozen supersteps, and nothing ever
 * deleted one. The bytes are not the transcript and no summarising saves them.
 * They are the same words, again, 990 times.
 *
 * ── WHAT ACTUALLY READS AN OLDER CHECKPOINT — verified, not assumed ─────────
 * A prune that stranded a parked `interrupt()` would lose somebody's work,
 * which is far worse than the disk it saves. So the reads were traced through
 * `@langchain/langgraph` 1.4.15 rather than reasoned about, and there are
 * exactly four ways an older row is touched:
 *
 *   1. `getTuple` WITH a `checkpoint_id`. Its SQL is
 *      `WHERE thread_id = ? AND checkpoint_ns = ?` plus, without an id,
 *      `ORDER BY checkpoint_id DESC LIMIT 1`. Every config Telar builds carries
 *      `thread_id` alone (`runtime.ts`'s `config`, and `restore`'s), so every
 *      read Telar makes is the NEWEST row.
 *   2. `getStateHistory` / `saver.list`. That is LangGraph's time travel, and
 *      Telar exposes none: no route, no tool and no call site asks for it.
 *   3. `bulkUpdateState` with `asNode: "__copy__"`, which forks a thread from an
 *      older checkpoint. Telar never calls `updateState` at all.
 *   4. `ReplayState`, which loads a SUBGRAPH's checkpoint from before a parent's
 *      replay point. It is reached only when a `checkpoint_id` was requested,
 *      and the Agent's graph has no subgraphs.
 *
 * `saved.parentConfig` looks like a fifth and is not: the pregel loop keeps it
 * only as an ID, for the `parent_id` on a streamed checkpoint envelope and for
 * the time-travel branch above. Nothing dereferences the row.
 *
 * ── SO THE WINDOW IS ONE, AND THE PARKED APPROVAL IS IN IT ──────────────────
 * `interrupt()` does not write a checkpoint of its own. The loop checkpoints at
 * the START of the superstep that then runs the tools node, the node throws, and
 * the interrupt is recorded as a PENDING WRITE against that same checkpoint —
 * which is therefore the newest one. Resuming reads it back through the
 * `pending_writes` subquery on exactly that row. `agent-checkpoint-retention.test.ts`
 * proves it end to end, across a close and a reopen, which is what a restart is.
 *
 * `keep` is a parameter regardless, because "the window is one" is a claim about
 * today's LangGraph and the cost of widening it is one row.
 *
 * ── WRITES FOLLOW THEIR CHECKPOINT ──────────────────────────────────────────
 * A `writes` row is only ever read through its own checkpoint — as that row's
 * `pending_writes` — so a write whose checkpoint is gone is unreachable by
 * construction. The one exception is `migratePendingSends`, which reads the
 * PARENT's writes, and it is guarded on `checkpoint.v < 4`: this
 * `@langchain/langgraph-checkpoint` writes v4, so no checkpoint this engine has
 * ever stored can take that path.
 *
 * ── AND WHY A DELETE ALONE WOULD NOT HAVE SHRUNK THE FILE ───────────────────
 * Deleted pages go on sqlite's free list and the file stays exactly as large as
 * it ever was. A machine already carrying 1.53 GB would have kept carrying it.
 * `reclaimFreeSpace` is the other half, and it is gated on the free list being
 * worth a rewrite so that the steady state never pays for one.
 */
import type { NativeDatabase } from "./checkpointer";

/**
 * HOW MANY CHECKPOINTS A THREAD KEEPS.
 *
 * One, for the reason traced in the header: every read Telar makes is the
 * newest row, and a parked approval is a pending write against it. Raising this
 * costs one full snapshot of the conversation per extra row, which is the whole
 * of what this file exists to stop.
 */
export const CHECKPOINTS_KEPT = 1;

/**
 * HOW MUCH FREE SPACE IS WORTH A REWRITE — 64 MB.
 *
 * A `VACUUM` rebuilds the database, so it is the one expensive thing here and
 * must not happen on an ordinary open. After the first prune a steady-state
 * store frees a few megabytes a turn and reuses those pages for the next
 * checkpoint, which never reaches this mark; a store that has been accumulating
 * since #531 crosses it once and then never again.
 */
export const VACUUM_MIN_BYTES = 64 * 1024 * 1024;

export type PruneReport = {
  /** Rows deleted from `checkpoints`. */
  checkpoints: number;
  /** Rows deleted from `writes`, whose checkpoints went with them. */
  writes: number;
};

/**
 * THE NEWEST `keep` CHECKPOINTS PER THREAD, AND NOTHING ELSE.
 *
 * PARTITIONED BY `(thread_id, checkpoint_ns)` rather than by thread alone. The
 * Agent's graph has no subgraphs so there is only ever the root namespace, but
 * a prune that ranked every namespace together would empty the smaller ones,
 * and "correct only while the graph stays flat" is not a property worth
 * shipping.
 *
 * ORDERED BY `checkpoint_id DESC`, which is the saver's own definition of
 * newest — a checkpoint id is a UUIDv6 and sorts by time, and it is the order
 * `getTuple` uses to decide which row IS the current one. Ordering by anything
 * else here would mean the prune and the read could disagree about which
 * checkpoint the conversation is at.
 *
 * SAFE BEFORE THE SAVER HAS RUN ITS `setup()`, which is the ordinary case on a
 * fresh machine: a store with no `checkpoints` table has nothing to prune and
 * says so, rather than creating a table whose schema belongs to the package.
 *
 * IDEMPOTENT, so it can run on open and again after every write.
 */
export function pruneCheckpoints(db: NativeDatabase, options: { keep?: number } = {}): PruneReport {
  const keep = Math.max(1, Math.trunc(options.keep ?? CHECKPOINTS_KEPT));
  if (!hasTable(db, "checkpoints")) return { checkpoints: 0, writes: 0 };

  db.prepare(
    `DELETE FROM checkpoints WHERE rowid IN (
       SELECT rowid FROM (
         SELECT rowid, ROW_NUMBER() OVER (PARTITION BY thread_id, checkpoint_ns ORDER BY checkpoint_id DESC) AS rank
           FROM checkpoints
       ) WHERE rank > ?
     )`,
  ).run(keep);
  const checkpoints = changes(db);

  if (!hasTable(db, "writes")) return { checkpoints, writes: 0 };
  db.prepare(
    `DELETE FROM writes WHERE NOT EXISTS (
       SELECT 1 FROM checkpoints
        WHERE checkpoints.thread_id = writes.thread_id
          AND checkpoints.checkpoint_ns = writes.checkpoint_ns
          AND checkpoints.checkpoint_id = writes.checkpoint_id
     )`,
  ).run();
  return { checkpoints, writes: changes(db) };
}

export type ReclaimReport = {
  /** What the free list was holding when the decision was taken. */
  freeBytes: number;
  vacuumed: boolean;
};

/**
 * GIVE THE PAGES BACK TO THE FILESYSTEM, WHEN THERE ARE ENOUGH TO BOTHER.
 *
 * `VACUUM` rather than `PRAGMA incremental_vacuum`: incremental vacuuming only
 * works on a database created with `auto_vacuum` on, and these were not — the
 * schema is the package's and it has always been written with sqlite's default.
 * Retrofitting it would itself require a full rewrite, so the rewrite is the
 * whole mechanism instead of a prelude to one.
 *
 * NOT IN A TRANSACTION AND NOT UNDER A STATEMENT, which is `VACUUM`'s own
 * precondition. It is called from `openAgentCheckpointer`, before the saver has
 * read anything and before any turn can run, and that is the only place it is
 * safe to call from.
 *
 * ── AND THE WAL TRUNCATE, WITHOUT WHICH NONE OF THIS IS OBSERVABLE ──────────
 * The saver opens the store `journal_mode=WAL`, and in WAL mode a `VACUUM`
 * writes the rebuilt database into the WAL: `page_count` drops from 9,785 to
 * 249 and the FILE does not move. Measured here, on a 40 MB fixture, the size
 * was identical before and after the vacuum and after a `close()` — the bytes
 * came back only on `wal_checkpoint(TRUNCATE)`. A reclaim that stopped at the
 * vacuum would have reported success and given a person nothing.
 */
export function reclaimFreeSpace(db: NativeDatabase, options: { minBytes?: number } = {}): ReclaimReport {
  const minBytes = options.minBytes ?? VACUUM_MIN_BYTES;
  const freeBytes = freeSpace(db);
  if (freeBytes < minBytes) return { freeBytes, vacuumed: false };
  db.exec("VACUUM");
  // Through `prepare` because this pragma ANSWERS — see `pragma` below — and a
  // failure here leaves a correct database in a file that is merely still
  // large, which is not worth failing an open over.
  try {
    db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  } catch {
    // A store that is not in WAL mode has no log to truncate and has already
    // shrunk; anything else is the harmless half.
  }
  return { freeBytes, vacuumed: true };
}

/** What the free list is worth, in bytes. Read through `prepare` rather than
 *  `exec` because a pragma that ANSWERS is a query, and `exec` throws its
 *  answer away on both of this engine's sqlite builds. */
function freeSpace(db: NativeDatabase): number {
  return pragma(db, "PRAGMA freelist_count") * pragma(db, "PRAGMA page_size");
}

function pragma(db: NativeDatabase, sql: string): number {
  try {
    const row = db.prepare(sql).get();
    // The column is named after the pragma and differs between the two
    // drivers, so the value is taken positionally.
    const value = row && typeof row === "object" ? Object.values(row as Record<string, unknown>)[0] : undefined;
    return typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : 0;
  } catch {
    // A pragma this build will not answer means "do not vacuum", which is the
    // conservative direction: a store that keeps its free list is a store that
    // is merely no larger than it was.
    return 0;
  }
}

function hasTable(db: NativeDatabase, name: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  return row !== undefined && row !== null;
}

/** How many rows the statement just run touched. Read the way `thread-log.ts`
 *  reads `last_insert_rowid()` — as its own SELECT — because the shape `run`
 *  answers with is the driver's rather than something both agree on. */
function changes(db: NativeDatabase): number {
  const row = db.prepare("SELECT changes() AS n").get() as { n: number | bigint } | undefined;
  return row?.n ? Number(row.n) : 0;
}
