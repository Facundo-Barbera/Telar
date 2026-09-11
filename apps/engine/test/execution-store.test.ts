import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore } from "../src/state";

const homes: string[] = [];
const stores: EngineStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.closeExecutionStore();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});
function setup(storage: "json" | "sqlite" = "sqlite") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-sqlite-")); homes.push(home);
  const store = new EngineStore(home, Date.now, { executionStorage: storage }); stores.push(store);
  store.registerProject({ id: "project_one", name: "one", root: "/tmp" });
  store.createSession({ id: "session_one", projectId: "project_one" });
  return { home, store };
}
test("SQLite commits projections, events and a receipt together; a lost response is replayed", () => {
  const { store } = setup();
  const action = () => store.submitTurn("session_one", { runId: "run_one", input: "hello" });
  const first = store.executeCommand("submit:session_one:run_one", action, "command_one");
  const cursor = store.eventCursor("session_one");
  const again = store.executeCommand("submit:session_one:run_one", () => { throw new Error("must not repeat"); }, "command_one");
  expect(again).toEqual(first);
  expect(store.eventCursor("session_one")).toBe(cursor);
  expect(store.turns("session_one")).toHaveLength(1);
});
test("an interrupted transaction rolls back both journal and queue and invalidates caches", () => {
  const { store } = setup();
  const before = store.eventCursor("session_one");
  expect(() => store.executeCommand("broken", () => {
    store.submitTurn("session_one", { runId: "run_rollback", input: "never accepted" });
    throw new Error("injected disk failure");
  })).toThrow("injected disk failure");
  expect(store.turns("session_one")).toEqual([]);
  expect(store.eventCursor("session_one")).toBe(before);
  store.submitTurn("session_one", { runId: "run_next", input: "after rollback" });
  expect(store.claimTurn("session_one", "worker_one")?.runId).toBe("run_next");
});
test("migration preserves history, keeps a backup, and reopening cannot return to stale JSON", () => {
  const { store: original, home } = setup("json");
  original.submitTurn("session_one", { runId: "run_one", input: "keep me" });
  const migrated = new EngineStore(home, Date.now, { executionStorage: "sqlite" }); stores.push(migrated);
  expect(migrated.turns("session_one")[0]?.input).toBe("keep me");
  expect(fs.existsSync(path.join(home, "execution-json-backup", "session_one", "queue.json"))).toBe(true);
  migrated.stopSession("session_one");
  migrated.closeExecutionStore(); stores.splice(stores.indexOf(migrated), 1);
  expect(() => new EngineStore(home, Date.now, { executionStorage: "json" })).toThrow("migrated");
  const reopened = new EngineStore(home); stores.push(reopened);
  expect(reopened.turns("session_one")[0]?.state).toBe("stopped");
  expect(reopened.readEvents("session_one").some((event) => event.type === "turn.stopped")).toBe(true);
});

test("a replayed Stop receipt cannot cancel a new message submitted afterward", () => {
  const { store } = setup();
  store.submitTurn("session_one", { runId: "run_first", input: "first" });
  const stop = () => store.executeCommand("stop:session_one", () => store.stopSession("session_one"), "command_stop");
  stop();
  store.submitTurn("session_one", { runId: "run_new", input: "new instruction" });
  stop();
  expect(store.turns("session_one").find((turn) => turn.runId === "run_new")?.state).toBe("queued");
});

test("task-stop deliveries survive reopening and only their owner can acknowledge them", () => {
  const { store, home } = setup();
  store.submitTurn("session_one", { runId: "run_one", input: "watch" });
  const turn = store.claimTurn("session_one", "worker_one")!;
  store.markRunning("session_one", turn.runId, turn.claim!.token);
  store.ingestObservations("session_one", turn.runId, turn.claim!.token, [{ kind: "task.started", task: {
    id: "task_one", kind: "background", state: "running", title: "watch", providerTaskId: "provider_one",
  } }]);
  store.stopSession("session_one");
  const pending = store.taskStopsForWorker("worker_one");
  expect(pending).toHaveLength(1);
  expect(store.taskStopsForWorker("worker_other", [pending[0]!.deliveryId!])).toEqual([]);
  store.closeExecutionStore(); stores.splice(stores.indexOf(store), 1);
  const reopened = new EngineStore(home); stores.push(reopened);
  expect(reopened.taskStopsForWorker("worker_one")).toEqual(pending);
  expect(reopened.taskStopsForWorker("worker_one", [pending[0]!.deliveryId!])).toEqual([]);
});

test("SIGKILL between projection and commit leaves no accepted turn or journal fragment", async () => {
  const { store, home } = setup();
  const cursor = store.eventCursor("session_one");
  store.closeExecutionStore(); stores.splice(stores.indexOf(store), 1);
  const child = Bun.spawn([process.execPath, "-e", `
    import { EngineStore } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/state.ts"))};
    const store = new EngineStore(process.argv[1]);
    store.executeCommand("crash", () => {
      store.submitTurn("session_one", { runId: "run_crashed", input: "uncommitted" });
      process.kill(process.pid, "SIGKILL");
    });
  `, home], { stdout: "ignore", stderr: "pipe" });
  expect(await child.exited).not.toBe(0);
  const reopened = new EngineStore(home); stores.push(reopened);
  expect(reopened.turns("session_one")).toEqual([]);
  expect(reopened.eventCursor("session_one")).toBe(cursor);
  reopened.submitTurn("session_one", { runId: "run_after", input: "still usable" });
  expect(reopened.claimTurn("session_one", "worker_after")?.runId).toBe("run_after");
});

test("export retains post-migration history and reopens in a JSON-only store", async () => {
  const { home, store } = setup();
  store.submitTurn("session_one", { runId: "run_export", input: "after migration" });
  store.stopSession("session_one");
  store.closeExecutionStore(); stores.splice(stores.indexOf(store), 1);
  const destination = `${home}-export`; homes.push(destination);
  const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../scripts/export-execution.ts"), home, destination], { stdout: "ignore", stderr: "pipe" });
  expect(await child.exited).toBe(0);
  const exported = new EngineStore(destination, Date.now, { executionStorage: "json" }); stores.push(exported);
  expect(exported.turns("session_one")[0]?.state).toBe("stopped");
  expect(exported.readEvents("session_one").at(-1)?.type).toBe("turn.stopped");
});

test("internal command receipts do not retain resolved provider credentials", async () => {
  const { store, home } = setup();
  store.executeCommand("claim-like", () => {
    store.submitTurn("session_one", { runId: "run_private", input: "hello" });
    return { providerInstance: { env: [{ name: "API_KEY", value: "private-fixture-token" }] } };
  });
  const { Database } = await import("bun:sqlite");
  const db = new Database(path.join(home, "execution.sqlite"));
  try { expect(JSON.stringify(db.query("SELECT result FROM receipts").all())).not.toContain("private-fixture-token"); }
  finally { db.close(); }
});

test("human Stop keeps agent traffic blocked across restart until a fresh human message", () => {
  const { home, store } = setup();
  store.executeCommand("stop", () => store.stopSession("session_one", "user"), "stop_guard");
  store.closeExecutionStore();
  const reopened = new EngineStore(home, Date.now, { executionStorage: "sqlite" }); stores.push(reopened);
  expect(() => reopened.submitAgentTurn("session_one", { runId: "run_noise", input: "checkpoint" })).toThrow("stopped by its user");
  expect(reopened.turns("session_one")).toHaveLength(0);
  reopened.submitTurn("session_one", { runId: "run_human", input: "new task" });
  reopened.executeCommand("stop", () => reopened.stopSession("session_one", "user"), "stop_guard");
  expect(reopened.getSession("session_one").agentMessagesBlocked).toBeUndefined();
  expect(reopened.submitAgentTurn("session_one", { runId: "run_fresh", input: "new report" }).replayed).toBe(false);
});

/**
 * A CACHED STATEMENT MUST NOT CARRY THE PREVIOUS CALL'S BINDINGS. Preparing
 * each query once is what stops sqlite recompiling the same seven statements
 * ten times a second, and the only way that can go wrong is a reused statement
 * answering for the row it was last run with — so this interleaves several
 * sessions through every cached path and demands each one's own answer back.
 */
test("statements reused across calls still answer for the row they were asked about", () => {
  const { store } = setup();
  for (const id of ["session_two", "session_three"]) store.createSession({ id, projectId: "project_one" });
  const sessions = ["session_one", "session_two", "session_three"];
  for (const sessionId of sessions) store.submitTurn(sessionId, { runId: `run_${sessionId}`, input: `text for ${sessionId}` });
  // Interleaved, and twice, so any statement is run against a different
  // session than the one that prepared it.
  for (let round = 0; round < 2; round += 1) {
    for (const sessionId of sessions) {
      expect(store.turns(sessionId).map((turn) => turn.input)).toEqual([`text for ${sessionId}`]);
      expect(store.eventCursor(sessionId)).toBeGreaterThan(0);
      expect(store.readEvents(sessionId).every((event) => event.sessionId === sessionId)).toBe(true);
    }
  }
  store.stopTurn("session_two", "run_session_two");
  store.deleteSession("session_two");
  expect(store.turns("session_one")).toHaveLength(1);
  expect(store.turns("session_three")).toHaveLength(1);
  expect(() => store.getSession("session_two")).toThrow();
});

/**
 * THE SCAN CACHE MUST NEVER OUTLIVE THE QUEUE IT DESCRIBES.
 *
 * Serving an unchanged queue from memory is what takes the worker heartbeat
 * from ten milliseconds to a tenth of one, and the only way it can be wrong is
 * by answering with a queue that has since moved. Each of these writes a queue
 * behind a scan that already ran and demands the new answer.
 */
test("a queue written after a scan is seen by the next scan", () => {
  const { store } = setup();
  store.submitTurn("session_one", { runId: "run_one", input: "hello" });
  expect(store.claimTurn("session_one", "worker_one")?.runId).toBe("run_one");
  // Populates the cache while there is nothing to report.
  expect(store.cancellationsForWorker("worker_one")).toEqual([]);
  store.stopSession("session_one", "user");
  expect(store.cancellationsForWorker("worker_one").map((cancel) => cancel.runId)).toEqual(["run_one"]);
});

test("a rolled-back stop is not reported to the worker that would have acted on it", () => {
  const { store } = setup();
  store.submitTurn("session_one", { runId: "run_one", input: "hello" });
  store.claimTurn("session_one", "worker_one");
  expect(store.cancellationsForWorker("worker_one")).toEqual([]);
  expect(() => store.executeCommand("broken-stop", () => {
    store.stopSession("session_one", "user");
    throw new Error("injected disk failure");
  })).toThrow("injected disk failure");
  // The transaction took the stop back, so there is nothing to cancel — and
  // the turn is still the claimed one it was before.
  expect(store.cancellationsForWorker("worker_one")).toEqual([]);
  expect(store.turns("session_one").map((turn) => turn.state)).toEqual(["claimed"]);
});

test("a session id reused after a delete does not inherit the old queue", () => {
  const { store } = setup();
  store.submitTurn("session_one", { runId: "run_one", input: "hello" });
  store.claimTurn("session_one", "worker_one");
  store.stopSession("session_one", "user");
  expect(store.cancellationsForWorker("worker_one")).toHaveLength(1);
  store.deleteSession("session_one");
  store.createSession({ id: "session_one", projectId: "project_one" });
  expect(store.turns("session_one")).toEqual([]);
  expect(store.cancellationsForWorker("worker_one")).toEqual([]);
});

/**
 * A DEAD CLAIM IS NOT FREE TO LEAVE LYING ABOUT.
 *
 * `stopSession` keeps the claim on a turn it stops so the worker holding it
 * hears about the stop — but the token names a registration, and none survives
 * a restart. Left there it is not inert: `queueConcernsAWorker` counts it, so
 * every Stop anybody ever pressed kept a session in the set the heartbeat
 * walks, for ever and across every restart.
 */
test("a restart retires the claim on a stopped turn without disturbing the session", () => {
  const { home, store } = setup();
  store.submitTurn("session_one", { runId: "run_one", input: "hello" });
  store.claimTurn("session_one", "worker_one");
  store.stopSession("session_one", "user");
  expect(store.turns("session_one")[0]?.claim?.workerId).toBe("worker_one");
  const before = store.getSession("session_one").updatedAt;
  store.closeExecutionStore(); stores.splice(stores.indexOf(store), 1);

  const reopened = new EngineStore(home, Date.now, { executionStorage: "sqlite" }); stores.push(reopened);
  reopened.recover(); // what the daemon runs at boot
  const turn = reopened.turns("session_one")[0]!;
  expect(turn.claim).toBeUndefined();
  // Only the token went. The turn still says what it was and how it ended,
  // and nothing about the session moved.
  expect(turn).toMatchObject({ runId: "run_one", input: "hello", state: "stopped", stopReason: "user" });
  expect(reopened.getSession("session_one").updatedAt).toBe(before);
  // And with no claim left, no worker is asked about this session again.
  expect(reopened.cancellationsForWorker("worker_one")).toEqual([]);
});
