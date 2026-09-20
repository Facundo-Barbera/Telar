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
