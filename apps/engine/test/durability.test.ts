/**
 * THE DURABILITY PRAGMAS, AND WHAT A TEST CAN HONESTLY SAY — issue #632.
 *
 * ══ WHAT CANNOT BE TESTED, STATED FIRST ══
 *
 * **You cannot test durability by not losing data.** A test that writes and
 * reads back proves the page cache works. Nothing in a test runner can
 * power-cycle a drive, and `fcntl(2)` records that some drives ignore the flush
 * request outright. So the strongest claim available is that the pragmas which
 * make sqlite ask for a device barrier are the ones in effect — a set of
 * VALUES, read back off the live connection, which is what is below.
 *
 * ══ AND ONE OF THESE ASSERTIONS IS VACUOUS FOR THE SHIPPED APP ══
 *
 * This suite runs under `bun:sqlite`, over Apple's system libsqlite3, which is
 * compiled with `DEFAULT_CKPTFULLFSYNC` — so `checkpoint_fullfsync` reads back
 * as 1 here whether or not the constructor sets it. The packaged app runs the
 * engine under Electron-as-Node on `node:sqlite`, where the default is 0 and
 * setting it is the whole change. An assertion here is therefore evidence about
 * the dev stack only. That is why the second test asserts BOTH DIRECTIONS on a
 * connection it owns, and why `scripts/durability-pragmas.mjs` exists to assert
 * the same three values under plain `node` against a real bundle.
 */
import { afterEach, expect, test } from "bun:test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExecutionStore } from "../src/execution-store";

const roots: string[] = [];
const stores: ExecutionStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) { try { store.close(); } catch { /* already closed by the test */ } }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function open(): { root: string; store: ExecutionStore } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-durability-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
  const store = new ExecutionStore(root);
  stores.push(store);
  return { root, store };
}

test("the durability pragmas are the ones in effect on the live connection, read back as values", () => {
  const { store } = open();
  // `synchronous=1` is NORMAL, spelled explicitly by the constructor because
  // entering WAL otherwise takes the build's own default — 1 under `bun:sqlite`
  // and 2 under `node:sqlite`, which is the divergence #632 found: the shipped
  // app was paying an fsync per commit nobody chose.
  expect(store.durabilityPragmas()).toEqual({ synchronous: 1, checkpointFullfsync: 1, fullfsync: 0 });
});

test("checkpoint_fullfsync moves in both directions on a raw connection, so the pragma is what sets it", () => {
  // THE BOTH-DIRECTIONS HALF, on a connection this test owns. A store cannot
  // show it — it only ever sets ON — and the runtime default is already 1 under
  // bun, so "absent → 0" is not reproducible here. What IS reproducible on
  // every runtime is that the pragma moves the value both ways, which is what
  // makes the constructor's line load-bearing rather than decorative.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-durability-raw-"));
  roots.push(root);
  type Raw = { exec(sql: string): void; prepare(sql: string): { get(): Record<string, unknown> | undefined }; close(): void };
  const native = createRequire(import.meta.url)(process.versions.bun ? "bun:sqlite" : "node:sqlite") as {
    Database?: new (file: string) => Raw;
    DatabaseSync?: new (file: string) => Raw;
  };
  const file = path.join(root, "raw.sqlite");
  const db = process.versions.bun ? new native.Database!(file) : new native.DatabaseSync!(file);
  const read = () => Number(Object.values(db.prepare("PRAGMA checkpoint_fullfsync").get() ?? {})[0] ?? 0);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA checkpoint_fullfsync=OFF;");
  expect(read()).toBe(0);
  db.exec("PRAGMA checkpoint_fullfsync=ON;");
  expect(read()).toBe(1);
  db.close();
});

test("an explicit synchronous survives entering WAL, which is why the constructor may set it first", () => {
  // The Agent's checkpointer cannot set its level after `journal_mode=WAL`,
  // because the saver enters WAL lazily inside its own `setup()`. It sets it
  // BEFORE, and this is the property that makes that legal: a level set
  // explicitly is remembered across the mode change. Without it the shipped
  // app's thread store would run at FULL, an unmeasured fsync per commit in
  // production only (#632 §3).
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-durability-order-"));
  roots.push(root);
  type Raw = { exec(sql: string): void; prepare(sql: string): { get(): Record<string, unknown> | undefined }; close(): void };
  const native = createRequire(import.meta.url)(process.versions.bun ? "bun:sqlite" : "node:sqlite") as {
    Database?: new (file: string) => Raw;
    DatabaseSync?: new (file: string) => Raw;
  };
  const file = path.join(root, "order.sqlite");
  const db = process.versions.bun ? new native.Database!(file) : new native.DatabaseSync!(file);
  db.exec("PRAGMA synchronous=NORMAL;");
  db.exec("PRAGMA journal_mode=WAL;");
  expect(Number(Object.values(db.prepare("PRAGMA synchronous").get() ?? {})[0] ?? 0)).toBe(1);
  db.close();
});

type Barrier = { sessionId: string; eventId: number };
function watching(barriers: Barrier[]): { root: string; store: ExecutionStore } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-durability-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
  const store = new ExecutionStore(root, { onDurabilityBarrier: (event) => { barriers.push(event); } });
  stores.push(store);
  store.write(path.join(root, "sessions", "session_one", "session.json"), { id: "session_one" });
  return { root, store };
}

const at = Date.parse("2026-09-01T00:00:00Z");
/** One event, in the journal's own shape. `at` is fixed: nothing here is about
 *  time, and a clock in a fixture is a flake waiting for a slow machine. */
const event = (id: number, type: string, extra: Record<string, unknown> = {}) =>
  ({ id, at, sessionId: "session_one", runId: "run_one", type, ...extra }) as never;

test("one barrier per settled turn and none per delta — counted, not timed", () => {
  const barriers: Barrier[] = [];
  const { store } = watching(barriers);
  let id = 0;
  // THE DELTA SIDE. Sixty streamed deltas across three commits, exactly as the
  // engine coalesces them, and not one of them may buy a barrier — that is the
  // per-commit cost #632 measured at 2.32 ms per event on a USB enclosure and
  // ruled off the table.
  for (let commit = 0; commit < 3; commit += 1) {
    store.transaction(`stream_${commit}`, () => {
      for (let n = 0; n < 20; n += 1) store.append(event((id += 1), "content.delta", { itemId: "item_one", text: "x" }));
    });
  }
  expect(barriers).toHaveLength(0);

  // THE TURN SIDE. Each terminal type ends a turn, so each buys exactly one.
  for (const type of ["turn.completed", "turn.failed", "turn.stopped", "turn.ambiguous", "turn.discarded"]) {
    store.transaction(`end_${type}`, () => { store.append(event((id += 1), type)); });
  }
  expect(barriers).toHaveLength(5);
  // The barrier names the event it persisted, which is also what it wrote down.
  expect(barriers.at(-1)).toEqual({ sessionId: "session_one", eventId: id });

  // A turn that moved without ending — `turn.steered` and friends are
  // deliberately absent from `TERMINAL_TURN_TYPES` — adds nothing.
  store.transaction("steer", () => { store.append(event((id += 1), "turn.steered")); });
  expect(barriers).toHaveLength(5);
});
test("a rolled-back turn issues no barrier, because it never settled", () => {
  const barriers: Barrier[] = [];
  const { store } = watching(barriers);
  expect(() =>
    store.transaction("doomed", () => {
      store.append(event(9, "turn.completed"));
      throw new Error("injected disk failure");
    }),
  ).toThrow("injected disk failure");
  expect(barriers).toHaveLength(0);
  /**
   * AND THE ARMING MUST NOT OUTLIVE THE ROLLBACK — which is a different claim
   * from the one above, and the only one that catches a missing reset.
   *
   * The throw leaves `transaction` through its catch, so the doomed turn's own
   * barrier is never issued whether or not the flag was cleared. What a stale
   * flag does is fire on the NEXT commit — and the next commit is usually
   * another turn, which overwrites the flag and hides it. So the next scope
   * here appends a DELTA and nothing else: a store that forgot to clear would
   * barrier here, labelled with event 9, a turn that was rolled back.
   */
  store.transaction("stream", () => { store.append(event(1, "content.delta", { itemId: "item_one", text: "x" })); });
  expect(barriers).toHaveLength(0);
  // And a real turn afterwards still gets exactly one, named for itself.
  store.transaction("real", () => { store.append(event(2, "turn.completed")); });
  expect(barriers).toEqual([{ sessionId: "session_one", eventId: 2 }]);
});

test("the barrier leaves the connection exactly as it found it", () => {
  const { store } = watching([]);
  store.transaction("end", () => { store.append(event(1, "turn.completed")); });
  // RESTORED, NOT LEFT RAISED. A store that forgot to put `synchronous` back
  // would pass every count above while quietly paying an fsync per commit
  // forever after the first turn ended — the exact regression this asserts is
  // absent, in values rather than in a promise.
  expect(store.durabilityPragmas()).toEqual({ synchronous: 1, checkpointFullfsync: 1, fullfsync: 0 });
});

test("the barrier records where durability reached, and the row survives a reopen", () => {
  const { root, store } = watching([]);
  store.transaction("end", () => { store.append(event(7, "turn.completed")); });
  store.close();
  stores.splice(stores.indexOf(store), 1);
  const reopened = new ExecutionStore(root);
  stores.push(reopened);
  // Read through the store's own document surface rather than by reaching into
  // sqlite: the row is the barrier's write, and its value is the event it
  // persisted. A barrier that wrote nothing would produce no WAL frame and
  // therefore no sync at all, so this is also how the mechanism is held up.
  expect(reopened.barrierWatermark()).toBe("session_one:7");
});
