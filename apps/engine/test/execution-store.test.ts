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
