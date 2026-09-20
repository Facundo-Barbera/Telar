/**
 * WHAT A DEVICE BARRIER COSTS, AND HOW OFTEN THE STORE ASKS FOR ONE — issue #632.
 *
 *   bun run --cwd apps/engine bench:durability            # 8 turns × 1,920 events
 *   bun run --cwd apps/engine bench:durability 20 3000    # turns, events per turn
 *
 * IT PRINTS NUMBERS AND NEVER FAILS. A timing assertion here would be an
 * assertion about the runner's disk: the same call measured 2.0 ms on this
 * machine's internal SSD and 96.8 ms on a USB enclosure (#632). What a test can
 * hold the code to is which pragmas are in effect and how many barriers were
 * issued — `durability.test.ts` does both, in counts. This answers the other
 * question, the one only a measurement can: is `checkpoint_fullfsync=ON` cheap
 * enough to leave on, given how often this store actually checkpoints.
 *
 * ══ HOW A CHECKPOINT IS COUNTED ══
 *
 * The WAL header carries a CHECKPOINT SEQUENCE at byte offset 12, big-endian,
 * incremented every time a checkpoint resets the log. Reading it before and
 * after a workload is the only honest count available from outside sqlite: the
 * WAL file does not shrink on an automatic checkpoint (it is overwritten from
 * the front), so a size delta says nothing, and `PRAGMA wal_checkpoint` reports
 * the checkpoint it just ran rather than the ones autocheckpoint ran for us.
 *
 * ══ THE FIXTURE IS A LONG SESSION, WHICH IS THE SHAPE THAT DECIDES IT ══
 *
 * The cost of leaving `checkpoint_fullfsync` on is (barrier × checkpoints), and
 * the checkpoint rate is set by bytes written, not by turns. A long streaming
 * session is where that rate is highest — #658 measures `items.json` rewritten
 * whole on every item event, up to 17 MiB a rewrite — so the fixture streams
 * deltas of the measured average size (261 bytes) and rewrites a document per
 * turn, and reports events per checkpoint rather than a bare count.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Where the fixture database is built. The default is the OS temp dir, which on
 *  a Mac is the internal SSD; point it at a slow disk to measure the case the
 *  decision actually turns on — a barrier is 2 ms on one and 97 ms on the other
 *  (#632), and only the checkpoint COUNT is the same on both. */
const SCRATCH = process.env.TELAR_BENCH_DIR ?? os.tmpdir();

const [turnArg, eventArg] = process.argv.slice(2).map(Number);
const TURNS = Number.isSafeInteger(turnArg) && turnArg > 0 ? turnArg : 8;
const EVENTS_PER_TURN = Number.isSafeInteger(eventArg) && eventArg > 0 ? eventArg : 1_920;
/** The measured average `content.delta` payload on the owner's store (#632). */
const DELTA_BYTES = 261;
/** What the engine coalesces into one transaction — `FLUSH_COUNT`. */
const BATCH = 32;

type Db = { exec(sql: string): void; prepare(sql: string): { get(...a: unknown[]): Record<string, unknown> | undefined; run(...a: unknown[]): unknown }; close(): void };
const native = createRequire(import.meta.url)(process.versions.bun ? "bun:sqlite" : "node:sqlite") as {
  Database?: new (file: string) => Db;
  DatabaseSync?: new (file: string) => Db;
};

function open(file: string, fullfsync: boolean): Db {
  const db = (process.versions.bun ? new native.Database!(file) : new native.DatabaseSync!(file)) as Db;
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA checkpoint_fullfsync=${fullfsync ? "ON" : "OFF"};`);
  db.exec("CREATE TABLE IF NOT EXISTS events (session_id TEXT NOT NULL, id INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(session_id,id));");
  db.exec("CREATE TABLE IF NOT EXISTS documents (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
  return db;
}

/** The WAL's own checkpoint counter — see the header. Zero when there is no WAL
 *  yet, which is the honest answer for a database nothing has written to. */
function checkpointSeq(file: string): number {
  try {
    const wal = fs.readFileSync(`${file}-wal`);
    return wal.length >= 16 ? wal.readUInt32BE(12) : 0;
  } catch {
    return 0;
  }
}

const pragma = (db: Db, name: string): unknown => Object.values(db.prepare(`PRAGMA ${name}`).get() ?? {})[0];

/** One turn's worth of journal: `BATCH`-coalesced delta commits, one document
 *  rewrite, then the terminal turn event. Returns the barrier count it would
 *  have issued under change 3 — one, always, which is the point. */
function runTurn(db: Db, turn: number, barrier: (() => void) | undefined): void {
  const text = "x".repeat(DELTA_BYTES);
  const insert = db.prepare("INSERT INTO events(session_id,id,value) VALUES(?,?,?)");
  let id = turn * (EVENTS_PER_TURN + 1);
  for (let written = 0; written < EVENTS_PER_TURN; written += BATCH) {
    db.exec("BEGIN IMMEDIATE");
    for (let n = 0; n < Math.min(BATCH, EVENTS_PER_TURN - written); n += 1) {
      insert.run("session_one", (id += 1), JSON.stringify({ id, type: "content.delta", text }));
    }
    db.exec("COMMIT");
  }
  // The document rewrite a streaming turn pays per item (#658), once per turn
  // here rather than per item — the WAL cost is what is being counted, and a
  // whole-document rewrite is where most of it comes from.
  db.exec("BEGIN IMMEDIATE");
  db.prepare("INSERT INTO documents(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run("sessions/session_one/items.json", JSON.stringify({ items: Array.from({ length: turn * 8 + 8 }, (_, n) => ({ id: n, text })) }));
  insert.run("session_one", (id += 1), JSON.stringify({ id, type: "turn.completed" }));
  db.exec("COMMIT");
  barrier?.();
}

/** Change 3's barrier, as it can actually be issued: sqlite REFUSES
 *  `PRAGMA synchronous` inside a transaction ("Safety level may not be changed
 *  inside a transaction"), so the barrier is a second, tiny commit after the
 *  turn's own — which is the amortised pattern `fcntl(2)` documents, where one
 *  F_FULLFSYNC persists everything already written to that device. */
function barrierOf(db: Db): () => void {
  const mark = db.prepare("INSERT INTO documents(key,value) VALUES('durability-barrier',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  let n = 0;
  return () => {
    db.exec("PRAGMA synchronous=FULL; PRAGMA fullfsync=ON;");
    db.exec("BEGIN IMMEDIATE");
    mark.run(String((n += 1)));
    db.exec("COMMIT");
    db.exec("PRAGMA synchronous=NORMAL; PRAGMA fullfsync=OFF;");
  };
}

function measure(label: string, fullfsync: boolean, withBarrier: boolean): void {
  const root = fs.mkdtempSync(path.join(SCRATCH, "telar-durability-"));
  const file = path.join(root, "bench.sqlite");
  const db = open(file, fullfsync);
  const before = checkpointSeq(file);
  const started = performance.now();
  const barrier = withBarrier ? barrierOf(db) : undefined;
  for (let turn = 0; turn < TURNS; turn += 1) runTurn(db, turn, barrier);
  const elapsed = performance.now() - started;
  const after = checkpointSeq(file);
  const events = TURNS * (EVENTS_PER_TURN + 1);
  const checkpoints = after - before;
  const walPages = Number(pragma(db, "page_size")) || 4096;
  db.close();
  const bytes = fs.statSync(file).size;
  fs.rmSync(root, { recursive: true, force: true });
  console.log(
    `${label.padEnd(34)} ${elapsed.toFixed(0).padStart(7)} ms  ` +
      `${checkpoints.toString().padStart(4)} checkpoints  ` +
      `${checkpoints ? Math.round(events / checkpoints).toLocaleString("en-US").padStart(8) : "       —"} events/checkpoint  ` +
      `${(bytes / 1e6).toFixed(1).padStart(6)} MB  (${walPages} B pages)`,
  );
}

const probe = open(path.join(fs.mkdtempSync(path.join(SCRATCH, "telar-durability-probe-")), "p.sqlite"), true);
console.log(
  `runtime ${process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`}  ` +
    `scratch ${SCRATCH}  ` +
    `synchronous=${pragma(probe, "synchronous")} checkpoint_fullfsync=${pragma(probe, "checkpoint_fullfsync")} ` +
    `wal_autocheckpoint=${pragma(probe, "wal_autocheckpoint")}`,
);
probe.close();
console.log(`${TURNS} turns × ${EVENTS_PER_TURN.toLocaleString("en-US")} events, ${BATCH} per commit\n`);

measure("shipped today (ckpt_fullfsync OFF)", false, false);
measure("change 1 (ckpt_fullfsync ON)", true, false);
measure("change 1 + 3 (barrier per turn)", true, true);
