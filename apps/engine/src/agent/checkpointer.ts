/**
 * THE AGENT'S THREAD, ON DISK — the published saver over the engine's own
 * sqlite (#531).
 *
 * ── WHAT IS OURS AND WHAT IS THEIRS ─────────────────────────────────────────
 * The SCHEMA, the SQL, the serde and the pending-sends migration are
 * `@langchain/langgraph-checkpoint-sqlite`'s, unmodified. What this file
 * supplies is the DRIVER underneath them. That split is the whole point: a
 * durability claim about a checkpointer we reimplemented would be a claim about
 * our code, and the thing being relied on here is a package with its own tests.
 *
 * ── WHY A DRIVER ADAPTER AT ALL ─────────────────────────────────────────────
 * The saver's only dependency is `better-sqlite3`, a native addon. Bun cannot
 * host it — `'better-sqlite3' is not yet supported in Bun`, oven-sh/bun#4290 —
 * and the packaged .app has no compiler and no per-ABI prebuild to ship. So the
 * saver never opens a database: it is HANDED one, and the object it is handed
 * answers the five methods it actually calls (`pragma`, `exec`, `prepare` plus
 * the statement's `get`/`all`/`run`, and `transaction`) over whichever sqlite
 * this process has.
 *
 * ── THE SAME FORK `execution-store.ts` MAKES, AND FOR THE SAME REASON ───────
 * `bun:sqlite` in the dev stack and in the daemon; `node:sqlite` under
 * Electron-as-Node, which is what `apps/desktop/build-app.sh` bundles the
 * engine for. The lab's adapter was Bun-only because a lab only ever runs under
 * Bun; a packaged Telar would have imported a module that does not exist. The
 * fork is read from `process.versions.bun` exactly as the execution store reads
 * it, through `createRequire` so the bundler does not try to resolve a builtin
 * that belongs to the other runtime.
 *
 * ── THE THREE PLACES THE DRIVERS DISAGREE, AND WHAT IS DONE ABOUT EACH ──────
 * 1. `pragma()` exists on better-sqlite3 alone. Both others take the same
 *    statement through `exec`.
 * 2. `transaction()` exists on `bun:sqlite` and not on `node:sqlite`. It is
 *    written out here as BEGIN/COMMIT/ROLLBACK for BOTH rather than delegated
 *    to Bun's — one implementation, so a rollback cannot behave differently
 *    depending on which runtime the engine happens to be in.
 * 3. `undefined` is not a bindable parameter in any of the three, and the saver
 *    binds `parent_checkpoint_id` as `undefined` for a thread's first
 *    checkpoint. `bind` maps it to NULL, which is what the column means and
 *    what the row reads back as.
 *
 * ── THE ONE SQL OF OUR OWN, AND WHERE IT LIVES ──────────────────────────────
 * The split above held exactly until #599, which is the one thing the saver
 * does not do: it never deletes a checkpoint, so 993 full snapshots of one
 * conversation had accumulated into 1.53 GB. Retention is therefore ours, and
 * it is kept in `./retention.ts` — whose header traces which reads actually
 * touch an older row — rather than in here, so this file stays about the driver
 * and the DELETE stays in one reviewable place. `RetainingSqliteSaver` below is
 * the whole of the wiring: one override, calling one function.
 */
import { createRequire } from "node:module";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { CHECKPOINTS_KEPT, pruneCheckpoints, reclaimFreeSpace } from "./retention";

type Bindable = string | number | bigint | null | Uint8Array;

/** What a driver will actually take. `undefined` becomes NULL (see the header);
 *  a boolean becomes 0/1 because `node:sqlite` refuses one outright. */
const bind = (args: unknown[]): Bindable[] =>
  args.map((arg) => (arg === undefined ? null : typeof arg === "boolean" ? (arg ? 1 : 0) : (arg as Bindable)));

/** The narrow slice of either sqlite this adapter drives. Exported because the
 *  readable transcript (`./thread-log.ts`) lives in the SAME file and shares
 *  this handle: two connections to one WAL database would be two things to
 *  close before a reset could move it. */
export type NativeStatement = {
  get(...args: Bindable[]): unknown;
  all(...args: Bindable[]): unknown[];
  run(...args: Bindable[]): unknown;
};
export type NativeDatabase = {
  exec(sql: string): unknown;
  prepare(sql: string): NativeStatement;
  close(): void;
};

/**
 * The `better-sqlite3` surface `SqliteSaver` uses, over whichever sqlite this
 * process has.
 */
class SqliteDriverAdapter {
  constructor(private readonly db: NativeDatabase) {}

  pragma(source: string): unknown {
    return this.db.exec(`PRAGMA ${source}`);
  }

  exec(source: string): unknown {
    return this.db.exec(source);
  }

  prepare(sql: string) {
    const statement = this.db.prepare(sql);
    return {
      // `?? undefined` because `node:sqlite` answers a missing row with
      // `undefined` and `bun:sqlite` with `null`, and the saver checks for the
      // former.
      get: (...args: unknown[]) => statement.get(...bind(args)) ?? undefined,
      all: (...args: unknown[]) => statement.all(...bind(args)),
      run: (...args: unknown[]) => statement.run(...bind(args)),
    };
  }

  /**
   * ONE TRANSACTION IMPLEMENTATION FOR BOTH RUNTIMES.
   *
   * A THROW ROLLS BACK AND RE-THROWS. The saver's two callers (`putWrites`,
   * `deleteThread`) both expect a failure to reach them; swallowing one here
   * would leave a checkpoint the graph believes was written.
   */
  transaction<T extends unknown[]>(fn: (...args: T) => void): (...args: T) => void {
    return (...args: T) => {
      this.db.exec("BEGIN");
      try {
        fn(...args);
        this.db.exec("COMMIT");
      } catch (error) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // A rollback that fails means the transaction is already gone —
          // reporting it would replace the real error with a symptom.
        }
        throw error;
      }
    };
  }

  close(): void {
    this.db.close();
  }
}

/**
 * THE SAVER, PLUS THE ONE THING IT DOES NOT DO — see `./retention.ts`.
 *
 * ── WHY ON EVERY `put` AND NOT ONLY ON OPEN ─────────────────────────────────
 * On open was the obvious cheap answer and it is not enough on its own. A
 * superstep is a checkpoint, a turn is a dozen supersteps and one turn on the
 * owner's thread ran 312 of them: a daemon that pruned only at startup would
 * still write 450 MB of snapshots between two restarts, and the file would
 * still only ever grow. Pruning where the row is written is what makes the
 * store's size a function of the CONVERSATION rather than of the laps.
 *
 * ── AND WHY THAT IS SAFE HERE ───────────────────────────────────────────────
 * The row `put` has just written is by definition the newest, so it is the one
 * the prune keeps, and the `putWrites` that follows targets the same id. There
 * is no window in which the loop holds a checkpoint this could delete
 * underneath it.
 *
 * A FAILED PRUNE IS NOT A FAILED TURN. The checkpoint is already committed by
 * the time this runs; a delete that could not complete leaves a larger file and
 * nothing else, and turning that into a throw would let a disk-space problem
 * end a conversation.
 */
class RetainingSqliteSaver extends SqliteSaver {
  constructor(
    adapter: SqliteDriverAdapter,
    private readonly native: NativeDatabase,
    private readonly keep: number,
  ) {
    super(adapter as never);
  }

  override async put(...args: Parameters<SqliteSaver["put"]>): Promise<ReturnType<SqliteSaver["put"]> extends Promise<infer T> ? T : never> {
    const written = await super.put(...args);
    try {
      pruneCheckpoints(this.native, { keep: this.keep });
    } catch {
      // See the header: the conversation is already durable at this point.
    }
    return written;
  }
}

/** Open the file with whichever sqlite this runtime has. */
/**
 * THE TWO PRAGMAS THIS DATABASE NEVER SET, AND THE SHIPPED APP PAID FOR — #632.
 *
 * `SqliteSaver` sets `journal_mode=WAL` in its own `setup()` and never sets
 * `synchronous`, so the level this store runs at is whichever one the runtime's
 * sqlite was compiled to default to in WAL: NORMAL under `bun:sqlite` (Apple's
 * system libsqlite3) and **FULL under `node:sqlite`**, which is what the
 * packaged app runs. Nothing chose that. It is an unmeasured fsync per
 * checkpoint commit, in production only, on the Agent's hottest write.
 *
 * SO THIS PAIR IS NOT SYMMETRIC WITH THE EXECUTION STORE'S. There, adding
 * `checkpoint_fullfsync=ON` ADDS a barrier the shipped app was missing. Here,
 * `synchronous=NORMAL` REMOVES a per-commit fsync the shipped app was paying,
 * and `checkpoint_fullfsync=ON` puts the device barrier at the checkpoint where
 * it belongs — stronger where it matters and cheaper where it does not.
 *
 * SET BEFORE THE SAVER'S `setup()` ENTERS WAL, and that order is load-bearing:
 * a level set explicitly is remembered across the mode change (verified on both
 * runtimes), while one set after would be racing a lazy `setup()` that runs on
 * the first `put`. Explicit-then-WAL reads back as NORMAL either way.
 */
function setDurabilityPragmas(db: NativeDatabase): void {
  try {
    db.exec("PRAGMA synchronous=NORMAL; PRAGMA checkpoint_fullfsync=ON;");
  } catch {
    // A sqlite build that will not take one of these is still one the Agent can
    // converse on, exactly as the prune above is. Durability is worth asking
    // for and never worth refusing to open a thread store over.
  }
}

function openNative(file: string): NativeDatabase {
  const native = createRequire(import.meta.url)(process.versions.bun ? "bun:sqlite" : "node:sqlite") as {
    Database?: new (file: string, options?: { create?: boolean }) => NativeDatabase;
    DatabaseSync?: new (file: string) => NativeDatabase;
  };
  if (process.versions.bun) return new native.Database!(file, { create: true });
  return new native.DatabaseSync!(file);
}

export type OpenedCheckpointer = {
  saver: BaseCheckpointSaver;
  /** The same handle, for the transcript table beside the checkpoints — see
   *  `NativeDatabase`. Nothing else may hold it: closing is the reset's
   *  precondition and there must be exactly one thing to close. */
  db: NativeDatabase;
  /** Where the thread lives, so a diagnostic can say it without this module
   *  having to know the layout. */
  location: string;
  /** Closes the database. The caller MUST do this before anything moves the
   *  file — see `store.ts`'s `archiveThreadFile`. Idempotent. */
  close(): void;
};

/**
 * The Agent's durable thread store.
 *
 * `:memory:` IS A LEGITIMATE ARGUMENT and is what a test that does not care
 * about a restart passes. It is not a fallback: a caller that asked for a file
 * and got memory would report a thread as durable when it is not, which is the
 * one failure this module cannot afford.
 *
 * OPENING PRUNES — see `./retention.ts` and the comment in the body. `keep` is
 * there so a test can widen the window without reaching past this function; the
 * default is the one the engine ships.
 */
export function openAgentCheckpointer(file: string, options: { keep?: number } = {}): OpenedCheckpointer {
  const db = openNative(file);
  setDurabilityPragmas(db);
  const adapter = new SqliteDriverAdapter(db);
  /**
   * PRUNED ON OPEN, BEFORE ANYTHING READS IT — #599, and the reason this is not
   * left to the first `put`.
   *
   * A machine upgrading into this build already has the 1.53 GB. Nothing would
   * touch it until its owner spoke to the Agent, and the free pages would only
   * be reclaimed if a turn happened to run; doing it here means the file shrinks
   * on the next daemon start whether or not anybody says anything.
   *
   * THE ORDER MATTERS: the delete must land before the free list is measured,
   * or the rewrite would be skipped on exactly the store that needs it. A fresh
   * machine has no `checkpoints` table yet — the saver's `setup()` is lazy — so
   * both calls see nothing to do and cost one `sqlite_master` read.
   */
  const keep = options.keep ?? CHECKPOINTS_KEPT;
  try {
    pruneCheckpoints(db, { keep });
    reclaimFreeSpace(db);
  } catch {
    // A store that will not prune is still a store the Agent can converse on,
    // and refusing to open it would cost the conversation to save the disk.
  }
  const saver = new RetainingSqliteSaver(adapter, db, keep);
  let closed = false;
  return {
    saver,
    db,
    location: file,
    close: () => {
      if (closed) return;
      closed = true;
      try {
        adapter.close();
      } catch {
        // A database already closed underneath us is not worth a throw on a
        // path whose whole job is to release a handle.
      }
    },
  };
}
