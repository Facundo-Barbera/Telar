/**
 * SEND NOW, at the store: promote → deliver → steered, and every path where
 * delivery does NOT happen puts the message back in the queue. The property
 * under test is not-losing: a promoted message either reaches the provider or
 * runs as its own turn — it never vanishes.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStateError, EngineStore } from "../src/state";

const roots: string[] = [];
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-steering-"));
  roots.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function readyStore(): EngineStore {
  const store = new EngineStore(root(), () => 100);
  store.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  store.createSession({ id: "session_one", projectId: "project_one" });
  return store;
}

/** A running first turn and a queued second — the send-now starting position. */
function runningPlusQueued(store: EngineStore): { token: string } {
  store.submitTurn("session_one", { runId: "run_live", input: "Long task" });
  const claimed = store.claimTurn("session_one", "worker_one")!;
  store.markRunning("session_one", "run_live", claimed.claim!.token);
  store.submitTurn("session_one", { runId: "run_next", input: "Also do this" });
  return { token: claimed.claim!.token };
}

const turnState = (store: EngineStore, runId: string): string =>
  store.turns("session_one").find((turn) => turn.runId === runId)!.state;

test("promote → heartbeat → ack is the delivery path, and ack is idempotent", () => {
  const store = readyStore();
  const { token } = runningPlusQueued(store);

  const promoted = store.promoteTurn("session_one", "run_next");
  expect(promoted).toMatchObject({ state: "steering", steer: { intoRunId: "run_live" } });

  // The heartbeat carries the text to the worker holding the running claim,
  // and to nobody else.
  expect(store.steerForWorker("worker_one")).toEqual([
    { sessionId: "session_one", runId: "run_live", claimToken: token, steerRunId: "run_next", text: "Also do this" },
  ]);
  expect(store.steerForWorker("worker_two")).toEqual([]);

  const acked = store.ackSteer("session_one", "run_next", token);
  expect(acked.state).toBe("steered");
  expect(acked.steer?.deliveredAt).toBeDefined();
  // A retried ack after a dropped response is the same answer, not a conflict.
  expect(store.ackSteer("session_one", "run_next", token).state).toBe("steered");
  // Delivered means gone from the heartbeat.
  expect(store.steerForWorker("worker_one")).toEqual([]);
});

test("only a queued turn can be promoted, and only into a running one", () => {
  const store = readyStore();
  store.submitTurn("session_one", { runId: "run_next", input: "hello" });
  // Nothing running: with nothing to steer into, "send now" is
  // indistinguishable from "wait one moment".
  expect(() => store.promoteTurn("session_one", "run_next")).toThrow(EngineStateError);

  const claimed = store.claimTurn("session_one", "worker_one")!;
  store.markRunning("session_one", "run_next", claimed.claim!.token);
  // A running turn is not a promotable one.
  expect(() => store.promoteTurn("session_one", "run_next")).toThrow(EngineStateError);
});

test("the running turn settling FIRST puts an undelivered message back in the queue", () => {
  const store = readyStore();
  const { token } = runningPlusQueued(store);
  store.promoteTurn("session_one", "run_next");

  store.completeTurn("session_one", "run_live", token, { text: "done" });
  // NOT-LOSING: the message is queued again, claimable as an ordinary turn.
  expect(turnState(store, "run_next")).toBe("queued");
  const events = store.readEvents("session_one").filter((event) => event.type === "turn.requeued");
  expect(events).toHaveLength(1);
  expect(store.claimTurn("session_one", "worker_one")?.runId).toBe("run_next");
});

test("a stop and a failure sweep the same way a completion does", () => {
  const store = readyStore();
  const { token } = runningPlusQueued(store);
  store.promoteTurn("session_one", "run_next");
  store.stopTurn("session_one", "run_live");
  expect(turnState(store, "run_next")).toBe("queued");

  // Again, with a failure.
  const claimed = store.claimTurn("session_one", "worker_one")!;
  store.markRunning("session_one", "run_next", claimed.claim!.token);
  store.submitTurn("session_one", { runId: "run_third", input: "and this" });
  store.promoteTurn("session_one", "run_third");
  store.failTurn("session_one", "run_next", claimed.claim!.token, { code: "driver_failed", message: "boom" });
  expect(turnState(store, "run_third")).toBe("queued");
  void token;
});

test("a DELIVERED message stays steered when the turn settles — its words are part of that run", () => {
  const store = readyStore();
  const { token } = runningPlusQueued(store);
  store.promoteTurn("session_one", "run_next");
  store.ackSteer("session_one", "run_next", token);
  store.completeTurn("session_one", "run_live", token, { text: "done" });
  expect(turnState(store, "run_next")).toBe("steered");
  // And it is not claimable: the queue holds nothing.
  expect(store.claimTurn("session_one", "worker_one")).toBeUndefined();
});

test("recover() requeues an orphaned steering turn instead of stranding it", () => {
  const stateRoot = root();
  const first = new EngineStore(stateRoot, () => 100);
  first.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  first.createSession({ id: "session_one", projectId: "project_one" });
  first.submitTurn("session_one", { runId: "run_live", input: "Long task" });
  const claimed = first.claimTurn("session_one", "worker_one")!;
  first.markRunning("session_one", "run_live", claimed.claim!.token);
  first.submitTurn("session_one", { runId: "run_next", input: "Also this" });
  first.promoteTurn("session_one", "run_next");

  // A fresh store over the same root is the restart.
  const second = new EngineStore(stateRoot, () => 200);
  const recovered = second.recover();
  expect(recovered.ambiguous).toEqual(["run_live"]);
  expect(recovered.requeued).toContain("run_next");
  expect(second.turns("session_one").find((turn) => turn.runId === "run_next")?.state).toBe("queued");
});

test("promotion is refused while the provider compacts, mirroring the provider's own refusal", () => {
  const store = readyStore();
  const { token } = runningPlusQueued(store);
  // The running turn opens a compaction row.
  store.ingestObservations("session_one", "run_live", token, [
    { kind: "item.started", item: { id: "item_cc", detail: { type: "context_compaction" }, title: "Compacting context" } },
  ]);
  expect(() => store.promoteTurn("session_one", "run_next")).toThrow(/compacting/);
  // Closed, the gate opens again.
  store.ingestObservations("session_one", "run_live", token, [{ kind: "item.completed", itemId: "item_cc", status: "completed" }]);
  expect(store.promoteTurn("session_one", "run_next").state).toBe("steering");
});
