import { afterEach, expect, test } from "bun:test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExecutionStore } from "./execution-store";
import { barrierWatermark, durabilityPragmas } from "../../../test/store-internals";

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
  expect(durabilityPragmas(store)).toEqual({ synchronous: 1, checkpointFullfsync: 1, fullfsync: 0 });
});

test("checkpoint_fullfsync moves in both directions on a raw connection, so the pragma is what sets it", () => {
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
  store.transaction("stream", () => { store.append(event(1, "content.delta", { itemId: "item_one", text: "x" })); });
  expect(barriers).toHaveLength(0);
  // And a real turn afterwards still gets exactly one, named for itself.
  store.transaction("real", () => { store.append(event(2, "turn.completed")); });
  expect(barriers).toEqual([{ sessionId: "session_one", eventId: 2 }]);
});

test("the barrier leaves the connection exactly as it found it", () => {
  const { store } = watching([]);
  store.transaction("end", () => { store.append(event(1, "turn.completed")); });
  expect(durabilityPragmas(store)).toEqual({ synchronous: 1, checkpointFullfsync: 1, fullfsync: 0 });
});

test("the barrier records where durability reached, and the row survives a reopen", () => {
  const { root, store } = watching([]);
  store.transaction("end", () => { store.append(event(7, "turn.completed")); });
  store.close();
  stores.splice(stores.indexOf(store), 1);
  const reopened = new ExecutionStore(root);
  stores.push(reopened);
  expect(barrierWatermark(reopened)).toBe("session_one:7");
});
