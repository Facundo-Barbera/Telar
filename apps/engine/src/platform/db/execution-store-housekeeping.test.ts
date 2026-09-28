import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore } from "../../state";
import { ExecutionStore } from "./execution-store";
import { toLegacyHome } from "../../../test/store-internals";
import { cleanup, homes, setup, stores } from "./execution-store-fixture";

afterEach(cleanup);

test("receipts outlive a retry and not a week; opening the store is itself a sweep", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-receipts-")); homes.push(root);
  fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
  const day = 24 * 60 * 60 * 1000;
  let clock = Date.parse("2026-09-01T00:00:00Z");
  let ran = 0;
  const count = (store: ExecutionStore, commandId: string) => store.transaction("count", () => (ran += 1), commandId);

  let store = new ExecutionStore(root, { now: () => clock });
  try {
    expect(count(store, "command_old")).toBe(1);
    // The receipt is the whole point: the same id does not run twice.
    expect(count(store, "command_old")).toBe(1);
    expect(ran).toBe(1);

    clock += 8 * day;
    count(store, "command_fresh");
    expect(ran).toBe(2);
    // Everything past the week goes — the store's own `import` marker included,
    // which is why this is not a fixed number — and nothing is left behind it.
    expect(store.pruneReceipts()).toBeGreaterThan(0);
    expect(store.pruneReceipts()).toBe(0);
    count(store, "command_old");
    expect(ran).toBe(3);
    count(store, "command_fresh");
    expect(ran).toBe(3);
  } finally { store.close(); }

  // What the daemon does on start, with a week of receipts behind it.
  clock += 8 * day;
  store = new ExecutionStore(root, { now: () => clock });
  try {
    count(store, "command_fresh");
    expect(ran).toBe(4);
  } finally { store.close(); }
});

test("a restart retires the claim on a stopped turn without disturbing the session", () => {
  const { home, store } = setup();
  store.intake.submitTurn("session_one", { runId: "run_one", input: "hello" });
  store.claims.claimTurn("session_one", "worker_one");
  store.turnLifecycle.stopSession("session_one", "user");
  expect(store.queries.turns("session_one")[0]?.claim?.workerId).toBe("worker_one");
  const before = store.records.get("session_one").updatedAt;
  store.closeExecutionStore(); stores.splice(stores.indexOf(store), 1);

  const reopened = new EngineStore(home, Date.now); stores.push(reopened);
  reopened.recovery.recover(); // what the daemon runs at boot
  const turn = reopened.queries.turns("session_one")[0]!;
  expect(turn.claim).toBeUndefined();
  // Only the token went. The turn still says what it was and how it ended,
  // and nothing about the session moved.
  expect(turn).toMatchObject({ runId: "run_one", input: "hello", state: "stopped", stopReason: "user" });
  expect(reopened.records.get("session_one").updatedAt).toBe(before);
  // And with no claim left, no worker is asked about this session again.
  expect(reopened.recovery.cancellationsForWorker("worker_one")).toEqual([]);
});

test("the pre-SQLite backup is kept for its week and then swept, and the sweep says what it took", () => {
  const day = 24 * 60 * 60 * 1000;
  let clock = Date.now();
  const { store: original, home } = setup();
  original.intake.submitTurn("session_one", { runId: "run_one", input: "keep me" });
  toLegacyHome(original, home); stores.splice(stores.indexOf(original), 1);

  // The migration itself, which is what writes the backup.
  const migrated = new EngineStore(home, Date.now); stores.push(migrated);
  const backup = path.join(home, "execution-json-backup");
  expect(fs.existsSync(path.join(backup, "session_one", "queue.json"))).toBe(true);
  // INSIDE ITS WEEK IT STAYS, and the report says so rather than nothing: a
  // migration that went wrong this morning still has its undo.
  const held = migrated.executionHousekeeping()?.backup;
  expect(held?.removed).toBe(false);
  expect(held!.files).toBeGreaterThan(0);
  expect(held!.bytes).toBeGreaterThan(0);
  expect(fs.existsSync(backup)).toBe(true);
  migrated.closeExecutionStore(); stores.splice(stores.indexOf(migrated), 1);

  // A WEEK LATER, ON THE ORDINARY START. Not a command anybody has to know to
  // run: the backlog this exists for is on machines nobody is administering.
  clock += 8 * day;
  const swept = new ExecutionStore(home, { now: () => clock });
  try {
    const report = swept.housekeeping.backup;
    expect(report?.removed).toBe(true);
    // And it says what went.
    expect(report!.files).toBeGreaterThan(0);
    expect(report!.bytes).toBeGreaterThan(0);
    expect(report!.ageMs).toBeGreaterThan(7 * day);
    expect(fs.existsSync(backup)).toBe(false);
    // The store it was a backup OF is untouched, which is the whole premise.
    expect(swept.sessionIds()).toContain("session_one");
  } finally { swept.close(); }

  // Idempotent: nothing to consider on the next start, and nothing reported.
  const again = new ExecutionStore(home, { now: () => clock + day });
  try {
    expect(again.housekeeping.backup).toBeUndefined();
  } finally { again.close(); }
});

test("a store with no migration behind it has no backup to consider", () => {
  const { store } = setup();
  // Born on sqlite: `importLegacy` never ran, so there is nothing to age and
  // nothing to say about it.
  expect(store.executionHousekeeping()?.backup).toBeUndefined();
  expect(store.executionHousekeeping()?.receipts).toBe(0);
});
