/**
 * STEERING, at the store: a message submitted while a turn runs goes INTO
 * that turn (submit → steering → deliver → steered), and every path where
 * delivery does NOT happen puts the message back in the queue. The property
 * under test is not-losing: a steered message either reaches the provider or
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

/** A running first turn, then a second message sent at it — which steers on submit. */
function runningPlusSteered(store: EngineStore): { token: string } {
  store.submitTurn("session_one", { runId: "run_live", input: "Long task" });
  const claimed = store.claimTurn("session_one", "worker_one")!;
  store.markRunning("session_one", "run_live", claimed.claim!.token);
  const second = store.submitTurn("session_one", { runId: "run_next", input: "Also do this" });
  expect(second.turn).toMatchObject({ state: "steering", steer: { intoRunId: "run_live" } });
  return { token: claimed.claim!.token };
}

const turnState = (store: EngineStore, runId: string): string =>
  store.turns("session_one").find((turn) => turn.runId === runId)!.state;

test("submit → heartbeat → ack is the delivery path, and ack is idempotent", () => {
  const store = readyStore();
  const { token } = runningPlusSteered(store);

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

test("with nothing running a message is queued, and promoteTurn refuses what is not queued", () => {
  const store = readyStore();
  expect(store.submitTurn("session_one", { runId: "run_next", input: "hello" }).turn.state).toBe("queued");
  // Nothing running: with nothing to steer into, "send now" is
  // indistinguishable from "wait one moment".
  expect(() => store.promoteTurn("session_one", "run_next")).toThrow(EngineStateError);

  const claimed = store.claimTurn("session_one", "worker_one")!;
  // Claimed but not yet running: still queued — a claim has no input stream yet.
  expect(store.submitTurn("session_one", { runId: "run_early", input: "early" }).turn.state).toBe("queued");
  store.markRunning("session_one", "run_next", claimed.claim!.token);
  // A running turn is not a promotable one.
  expect(() => store.promoteTurn("session_one", "run_next")).toThrow(EngineStateError);
  /**
   * AND THE MESSAGE WRITTEN INTO THE CLAIM WINDOW NO LONGER WAITS TO BE SENT
   * BY HAND. It was typed against a session the composer showed as live, and
   * starting the turn steers it (#209) — this line used to promote it, which
   * is the same delivery a beat later and only if somebody pressed the button.
   * It is refused now for exactly the reason the running turn is: not queued.
   */
  expect(turnState(store, "run_early")).toBe("steering");
  expect(() => store.promoteTurn("session_one", "run_early")).toThrow(EngineStateError);
});

test("the running turn settling FIRST puts an undelivered message back in the queue", () => {
  const store = readyStore();
  const { token } = runningPlusSteered(store);

  store.completeTurn("session_one", "run_live", token, { text: "done" });
  // NOT-LOSING: the message is queued again, claimable as an ordinary turn.
  expect(turnState(store, "run_next")).toBe("queued");
  const events = store.readEvents("session_one").filter((event) => event.type === "turn.requeued");
  expect(events).toHaveLength(1);
  expect(store.claimTurn("session_one", "worker_one")?.runId).toBe("run_next");
});

test("a stop and a failure sweep the same way a completion does", () => {
  const store = readyStore();
  runningPlusSteered(store);
  store.stopTurn("session_one", "run_live");
  expect(turnState(store, "run_next")).toBe("queued");

  // Again, with a failure.
  const claimed = store.claimTurn("session_one", "worker_one")!;
  store.markRunning("session_one", "run_next", claimed.claim!.token);
  expect(store.submitTurn("session_one", { runId: "run_third", input: "and this" }).turn.state).toBe("steering");
  store.failTurn("session_one", "run_next", claimed.claim!.token, { code: "driver_failed", message: "boom" });
  expect(turnState(store, "run_third")).toBe("queued");
});

test("a DELIVERED message stays steered when the turn settles — its words are part of that run", () => {
  const store = readyStore();
  const { token } = runningPlusSteered(store);
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
  expect(first.submitTurn("session_one", { runId: "run_next", input: "Also this" }).turn.state).toBe("steering");

  // A fresh store over the same root is the restart.
  const second = new EngineStore(stateRoot, () => 200);
  const recovered = second.recover();
  expect(recovered.ambiguous).toEqual(["run_live"]);
  expect(recovered.requeued).toContain("run_next");
  expect(second.turns("session_one").find((turn) => turn.runId === "run_next")?.state).toBe("queued");
});

test("while the provider compacts a message falls back to queued, and can be sent once the gate opens", () => {
  const store = readyStore();
  store.submitTurn("session_one", { runId: "run_live", input: "Long task" });
  const claimed = store.claimTurn("session_one", "worker_one")!;
  const token = claimed.claim!.token;
  store.markRunning("session_one", "run_live", token);
  // The running turn opens a compaction row.
  store.ingestObservations("session_one", "run_live", token, [
    { kind: "item.started", item: { id: "item_cc", detail: { type: "context_compaction" }, title: "Compacting context" } },
  ]);
  // Codex refuses a steer during compaction at the protocol level; the engine
  // mirrors that by NOT steering — queued, never lost.
  expect(store.submitTurn("session_one", { runId: "run_next", input: "Also do this" }).turn.state).toBe("queued");
  expect(() => store.promoteTurn("session_one", "run_next")).toThrow(/compacting/);
  // Closed, the gate opens again.
  store.ingestObservations("session_one", "run_live", token, [{ kind: "item.completed", itemId: "item_cc", status: "completed" }]);
  expect(store.promoteTurn("session_one", "run_next").state).toBe("steering");
});
