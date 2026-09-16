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
 */
import { createRequire } from "node:module";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";

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

/** Open the file with whichever sqlite this runtime has. */
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
 */
export function openAgentCheckpointer(file: string): OpenedCheckpointer {
  const db = openNative(file);
  const adapter = new SqliteDriverAdapter(db);
  const saver = new SqliteSaver(adapter as never);
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
