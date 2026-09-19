/**
 * THE DURABLE CHECKPOINTER, AND THE BUN PROBLEM IT WALKED INTO.
 *
 * ── THE FINDING ─────────────────────────────────────────────────────────────
 * `@langchain/langgraph-checkpoint-sqlite@1.0.4` is the official durable saver
 * for LangGraph JS, and it does not load under Bun:
 *
 *     SQLITE FAIL: 'better-sqlite3' is not yet supported in Bun.
 *     Track the status in https://github.com/oven-sh/bun/issues/4290
 *
 * `better-sqlite3` is its only dependency and it is a native addon Bun cannot
 * yet host. `node:sqlite` is not available in Bun 1.3.11 either. That is a real
 * cost for a Bun-first codebase and it is reported as one; it is not a reason to
 * fall back to `MemorySaver` and call the thread durable.
 *
 * ── THE FIX, AND WHY IT IS THIS ONE ─────────────────────────────────────────
 * The saver's SQL, its schema, its serde and its migration are the parts under
 * evaluation. `better-sqlite3` is only the driver. So the PUBLISHED SqliteSaver
 * class runs unmodified over `bun:sqlite` through the adapter below — thirty
 * lines answering the five methods it actually calls (`pragma`, `exec`,
 * `prepare`, the statement's `get`/`all`/`run`, and `transaction`).
 *
 * What this buys the report: the durability numbers are the real saver's, not a
 * reimplementation's, so "LangGraph's durable checkpointer resumes a thread in a
 * fresh process" is a claim about the shipped package. What it costs: one
 * adapter a real integration would have to own, or a Node runtime for the
 * engine's agent process. Both are in the migration plan.
 *
 * ── THE ONE BEHAVIOURAL DIFFERENCE, HANDLED ─────────────────────────────────
 * `better-sqlite3` and `bun:sqlite` both refuse `undefined` as a bound
 * parameter, and the saver binds `parent_checkpoint_id` as `undefined` for the
 * first checkpoint of a thread. `bind` maps `undefined` to `null` — which is
 * what the column means and what the row is read back as.
 */
import { Database as BunDatabase } from "bun:sqlite";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { MemorySaver } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";

type Bindable = string | number | bigint | boolean | null | Uint8Array;

/** `undefined` is not bindable in either driver; the column takes NULL. */
const bind = (args: unknown[]): Bindable[] => args.map((arg) => (arg === undefined ? null : (arg as Bindable)));

/** The `better-sqlite3` surface `SqliteSaver` uses, over `bun:sqlite`. */
class BunBetterSqliteAdapter {
  constructor(private readonly db: BunDatabase) {}

  pragma(source: string): unknown {
    return this.db.exec(`PRAGMA ${source}`);
  }

  exec(source: string): unknown {
    return this.db.exec(source);
  }

  prepare(sql: string) {
    const statement = this.db.prepare(sql);
    return {
      get: (...args: unknown[]) => statement.get(...bind(args)) ?? undefined,
      all: (...args: unknown[]) => statement.all(...bind(args)),
      run: (...args: unknown[]) => statement.run(...bind(args)),
    };
  }

  transaction<T extends unknown[]>(fn: (...args: T) => void): (...args: T) => void {
    return this.db.transaction(fn) as unknown as (...args: T) => void;
  }

  close(): void {
    this.db.close();
  }
}

export type CheckpointerChoice = "sqlite" | "memory";

export type OpenedCheckpointer = {
  saver: BaseCheckpointSaver;
  kind: CheckpointerChoice;
  /** Where the thread lives, for the scenario's own log. `:memory:` when it
   *  does not outlive the process — which is the comparison. */
  location: string;
  close(): void;
};

/**
 * Open a saver.
 *
 * BOTH ARE BUILT HERE so scenario 1 can run the same thread twice and report
 * the difference rather than assert it: the sqlite thread resumes in a fresh
 * process and the memory one does not exist there at all.
 */
export function openCheckpointer(choice: CheckpointerChoice, file?: string): OpenedCheckpointer {
  if (choice === "memory") {
    return { saver: new MemorySaver(), kind: "memory", location: "(process memory)", close: () => {} };
  }
  const location = file ?? ":memory:";
  const db = new BunDatabase(location, { create: true });
  const saver = new SqliteSaver(new BunBetterSqliteAdapter(db) as never);
  return { saver, kind: "sqlite", location, close: () => db.close() };
}
