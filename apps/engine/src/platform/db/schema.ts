import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

export type Statement = { run(...args: unknown[]): unknown; get(...args: unknown[]): Record<string, unknown> | undefined; all(...args: unknown[]): Array<Record<string, unknown>> };
export type Database = { exec(sql: string): void; prepare(sql: string): Statement; close(): void };

function addColumns(db: Database, table: string, columns: readonly string[]): void {
  for (const column of columns) {
    const name = column.split(" ")[0]!;
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((existing) => String(existing.name) === name))
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
  }
}

// FTS5 is a compile-time option and node:sqlite may lack it, so the table is attempted and `like` is the fallback.
function openSearchIndex(db: Database): "fts5" | "like" {
  try {
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS session_search USING fts5(
         text, session_id UNINDEXED, run_id UNINDEXED, tokenize='unicode61 remove_diacritics 2')`,
    );
    return "fts5";
  } catch {
    return "like";
  }
}

/** Opens `<root>/execution.sqlite` on Bun's or Node's built-in SQLite and brings its schema up to date. */
export function openDatabase(root: string): { db: Database; searchIndex: "fts5" | "like" } {
  const native = createRequire(import.meta.url)(process.versions.bun ? "bun:sqlite" : "node:sqlite");
  const file = path.join(root, "execution.sqlite");
  const db: Database = process.versions.bun ? new native.Database(file) : new native.DatabaseSync(file);
  try {
    fs.chmodSync(file, 0o600);
    // busy_timeout first: journal_mode=WAL takes a lock and needs the retry budget. synchronous after WAL,
    // which resets it. checkpoint_fullfsync is on under bun:sqlite by default and off under node:sqlite.
    // journal_size_limit truncates the WAL after a checkpoint instead of keeping it at its peak size.
    db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA checkpoint_fullfsync=ON; PRAGMA journal_size_limit=33554432;");
    const version = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
    if (version > 1) throw new Error("execution database requires a newer Telar version");
    // Every later table and column is additive and user_version stays 1, so an older binary still opens the store.
    db.exec(`CREATE TABLE IF NOT EXISTS documents (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (session_id TEXT NOT NULL, id INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(session_id,id));
      CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, command TEXT NOT NULL, result TEXT NOT NULL, at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA user_version=1;`);
    db.exec(`CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        rule TEXT NOT NULL,
        zone TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL DEFAULT 0,
        next_run_at INTEGER NOT NULL,
        last_run_at INTEGER,
        last_run_id TEXT,
        last_run_status TEXT,
        last_skipped_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS schedules_due ON schedules (enabled, next_run_at);
      CREATE INDEX IF NOT EXISTS schedules_session ON schedules (session_id);`);
    db.exec(`CREATE TABLE IF NOT EXISTS sessions (
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
    addColumns(db, "sessions", ["title TEXT", "branch TEXT", "woke_at INTEGER"]);
    db.exec(`CREATE TABLE IF NOT EXISTS turn_summaries (
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
      CREATE INDEX IF NOT EXISTS turn_summaries_outline ON turn_summaries(session_id, sequence);
      CREATE INDEX IF NOT EXISTS turn_summaries_unfinished ON turn_summaries(session_id) WHERE state IN ('queued','claimed','running','steering','ambiguous');
      CREATE INDEX IF NOT EXISTS turn_summaries_ended ON turn_summaries(ended_at);
      CREATE INDEX IF NOT EXISTS sessions_busy ON sessions(id) WHERE activity != 'idle';`);
    // A rowid table: large item values spill less than in a WITHOUT ROWID leaf. `ord` is first-open order.
    db.exec(`CREATE TABLE IF NOT EXISTS items (
        session_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        ord INTEGER NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY(session_id, item_id)
      );
      CREATE INDEX IF NOT EXISTS items_run ON items(session_id, run_id, ord);`);
    // usage_* is the SUM of a turn's usage rows plus their count: Codex rows are per call, Claude's last row is the total.
    addColumns(db, "turn_summaries", [
      "usage_input INTEGER", "usage_output INTEGER", "usage_cache_read INTEGER",
      "usage_cache_create INTEGER", "usage_reasoning INTEGER", "usage_rows INTEGER",
      "policy_requests TEXT",
    ]);
    const searchIndex = openSearchIndex(db);
    // Receipts from before this column carry 0 and go on the first prune.
    addColumns(db, "receipts", ["at INTEGER NOT NULL DEFAULT 0"]);
    return { db, searchIndex };
  } catch (error) {
    db.close();
    throw error;
  }
}
