import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { EngineEvent } from "@telar/engine-client";
import { atomicWrite } from "./atomic";

type Statement = { run(...args: unknown[]): unknown; get(...args: unknown[]): Record<string, unknown> | undefined; all(...args: unknown[]): Array<Record<string, unknown>> };
type Database = { exec(sql: string): void; prepare(sql: string): Statement; close(): void };
const FILES = new Set(["session.json", "queue.json", "items.json", "requests.json", "tasks.json"]);

/**
 * HOW LONG A STREAMED DELTA MAY SIT IN MEMORY, and how many may sit there.
 *
 * `synchronous=FULL` means one WAL fsync per transaction, and the engine runs
 * one transaction per `ingestObservations` call — so a driver reporting one
 * delta at a time buys one fsync per token-chunk. Measured on the dogfood Mac:
 * 0.116 ms for a single append, 0.025 ms each at sixteen per transaction. The
 * fsync is the whole cost and the batch size is the only lever on it.
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

/** Only a bench or a test sets these; production runs the constants above.
 *  `flushCount: 1` is the behaviour before coalescing — every delta written
 *  where it was appended — which is what makes the two comparable. */
export type ExecutionStoreOptions = { flushCount?: number; flushAfterMs?: number };

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
  constructor(readonly root: string, options: ExecutionStoreOptions = {}) {
    this.flushCount = Math.max(1, options.flushCount ?? FLUSH_COUNT);
    this.flushAfterMs = Math.max(0, options.flushAfterMs ?? FLUSH_AFTER_MS);
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
  events(sessionId: string, after = 0): EngineEvent[] {
    const stored = this.statement("SELECT value FROM events WHERE session_id=? AND id>? ORDER BY id").all(sessionId, after)
      .map((row) => JSON.parse(String(row.value)) as EngineEvent);
    // Held deltas are always newer than every stored row, so the tail appends.
    const held = this.held().filter((event) => event.sessionId === sessionId && event.id > after);
    return held.length ? [...stored, ...held] : stored;
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
  sessionIds(): string[] {
    return this.statement("SELECT key FROM documents WHERE key LIKE 'sessions/%/session.json'").all().map((row) => String(row.key).split("/")[1]!);
  }
  deleteSession(sessionId: string): void {
    this.alone(() => {
      // Store the held deltas so the DELETE below is what decides they are gone —
      // and so a rollback brings back a whole session, not a truncated one.
      this.drain(this.depth > 0);
      const prefix = `sessions/${sessionId}/`;
      this.statement("DELETE FROM documents WHERE substr(key,1,?)=?").run(prefix.length, prefix);
      this.statement("DELETE FROM events WHERE session_id=?").run(sessionId);
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
      // A receipt id this call just minted cannot already be on file, and the
      // streaming path mints one per delta — so the lookup is an index probe
      // per token-chunk that can only ever miss.
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
        this.statement("INSERT INTO receipts(id,command,result) VALUES(?,?,?)").run(receiptId, command,
          JSON.stringify(commandId === undefined ? {} : { value: result }));
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
            this.statement("INSERT INTO documents(key,value) VALUES(?,?)").run(`sessions/${entry.name}/${name}`, JSON.stringify(value));
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
