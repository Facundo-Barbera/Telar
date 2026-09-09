import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { EngineEvent } from "@telar/engine-client";
import { atomicWrite } from "./atomic";

type Statement = { run(...args: unknown[]): unknown; get(...args: unknown[]): Record<string, unknown> | undefined; all(...args: unknown[]): Array<Record<string, unknown>> };
type Database = { exec(sql: string): void; prepare(sql: string): Statement; close(): void };
const FILES = new Set(["session.json", "queue.json", "items.json", "requests.json", "tasks.json"]);

/** One authoritative execution database; legacy files become a migration backup.
 * Runtime adapters use the built-in SQLite API of Bun and Node/Electron.
 */
export class ExecutionStore {
  private readonly db: Database;
  private depth = 0;
  private closed = false;
  constructor(readonly root: string) {
    const native = createRequire(import.meta.url)(process.versions.bun ? "bun:sqlite" : "node:sqlite");
    const file = path.join(root, "execution.sqlite");
    this.db = process.versions.bun ? new native.Database(file) : new native.DatabaseSync(file);
    try {
    fs.chmodSync(file, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    const version = Number(this.db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
    if (version > 1) throw new Error("execution database requires a newer Telar version");
    this.db.exec(`CREATE TABLE IF NOT EXISTS documents (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (session_id TEXT NOT NULL, id INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(session_id,id));
      CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, command TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA user_version=1;`);
    if (!this.db.prepare("SELECT value FROM metadata WHERE key='imported'").get()) this.importLegacy();
    atomicWrite(path.join(root, "execution-store.json"), { version: 1, backend: "sqlite" });
    // A previous binary must fail closed instead of reading stale JSON state.
    for (const sessionId of this.sessionIds()) this.fenceLegacy(sessionId);
    } catch (error) { this.db.close(); throw error; }
  }
  owns(file: string): boolean {
    const key = path.relative(this.root, file);
    return key === "task-stops.json" || key === "subscriptions.json" || /^sessions\/[A-Za-z0-9_-]+\/(session|queue|items|requests|tasks)\.json$/.test(key);
  }
  read(file: string): unknown {
    const row = this.db.prepare("SELECT value FROM documents WHERE key=?").get(path.relative(this.root, file));
    return row ? JSON.parse(String(row.value)) : undefined;
  }
  write(file: string, value: unknown): void {
    this.db.prepare("INSERT INTO documents(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(path.relative(this.root, file), JSON.stringify(value));
    if (path.basename(file) === "session.json") this.fenceLegacy(path.basename(path.dirname(file)));
  }
  events(sessionId: string, after = 0): EngineEvent[] {
    return this.db.prepare("SELECT value FROM events WHERE session_id=? AND id>? ORDER BY id").all(sessionId, after)
      .map((row) => JSON.parse(String(row.value)) as EngineEvent);
  }
  cursor(sessionId: string): number {
    return Number(this.db.prepare("SELECT COALESCE(MAX(id),0) AS id FROM events WHERE session_id=?").get(sessionId)?.id ?? 0);
  }
  append(event: EngineEvent): void {
    this.db.prepare("INSERT INTO events(session_id,id,value) VALUES(?,?,?)").run(event.sessionId, event.id, JSON.stringify(event));
  }
  sessionIds(): string[] {
    return this.db.prepare("SELECT key FROM documents WHERE key LIKE 'sessions/%/session.json'").all().map((row) => String(row.key).split("/")[1]!);
  }
  deleteSession(sessionId: string): void {
    const prefix = `sessions/${sessionId}/`;
    this.db.prepare("DELETE FROM documents WHERE substr(key,1,?)=?").run(prefix.length, prefix);
    this.db.prepare("DELETE FROM events WHERE session_id=?").run(sessionId);
  }
  transaction<T>(command: string, operation: () => T, commandId?: string): T {
    if (this.depth > 0) return operation();
    const receiptId = commandId ?? crypto.randomUUID();
    const changesBefore = Number(this.db.prepare("SELECT total_changes() AS count").get()?.count ?? 0);
    this.db.exec("BEGIN IMMEDIATE");
    this.depth += 1;
    try {
      const known = this.db.prepare("SELECT command,result FROM receipts WHERE id=?").get(receiptId);
      if (known) {
        if (known.command !== command) throw new Error("command id was already used for a different command");
        this.db.exec("COMMIT");
        return JSON.parse(String(known.result)).value as T;
      }
      const result = operation();
      if (result && typeof (result as { then?: unknown }).then === "function") throw new Error("execution transactions must be synchronous");
      const changed = Number(this.db.prepare("SELECT total_changes() AS count").get()?.count ?? 0) !== changesBefore;
      if (commandId !== undefined || changed)
        // Internal receipts are audit markers, not replayable responses. In
        // particular, never retain a resolved worker claim's provider secrets.
        this.db.prepare("INSERT INTO receipts(id,command,result) VALUES(?,?,?)").run(receiptId, command,
          JSON.stringify(commandId === undefined ? {} : { value: result }));
      this.db.exec("COMMIT");
      return result;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    finally { this.depth -= 1; }
  }
  exportLegacy(destination: string): void {
    if (fs.existsSync(destination)) throw new Error("Export destination must not already exist");
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
    for (const row of this.db.prepare("SELECT key,value FROM documents ORDER BY key").all()) {
      const file = path.join(destination, String(row.key));
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      atomicWrite(file, JSON.parse(String(row.value)));
    }
    for (const id of this.sessionIds()) {
      const events = this.events(id);
      fs.writeFileSync(path.join(destination, "sessions", id, "events.ndjson"), events.map((event) => JSON.stringify(event) + "\n").join(""), { mode: 0o600 });
    }
  }
  close(): void { if (!this.closed) { this.db.close(); this.closed = true; } }
  private fenceLegacy(sessionId: string): void {
    const file = path.join(this.root, "sessions", sessionId, "session.json");
    // Avoid a disk write per metadata update; this is an immutable downgrade fence.
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8").includes('"backend": "sqlite"')) return;
    atomicWrite(file, { version: -1, backend: "sqlite", message: "This history requires a SQLite-capable Telar build." });
  }
  private importLegacy(): void {
    const backup = path.join(this.root, "execution-json-backup");
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
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
            this.db.prepare("INSERT INTO documents(key,value) VALUES(?,?)").run(`sessions/${entry.name}/${name}`, JSON.stringify(value));
          }
        }
      }
      for (const name of ["task-stops.json", "subscriptions.json"]) {
        const file = path.join(this.root, name);
        if (fs.existsSync(file)) {
          if (!fs.existsSync(path.join(backup, name))) fs.copyFileSync(file, path.join(backup, name), fs.constants.COPYFILE_EXCL);
          this.write(file, JSON.parse(fs.readFileSync(file, "utf8")));
        }
      }
      this.db.prepare("INSERT INTO metadata(key,value) VALUES('imported','1')").run();
    });
  }
}
