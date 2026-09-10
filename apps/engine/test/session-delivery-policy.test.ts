import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore } from "../src/state";
const homes: string[] = [];
const stores: EngineStore[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.closeExecutionStore(); for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true }); });
function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-delivery-")); homes.push(home);
  const store = new EngineStore(home, Date.now, { executionStorage: "sqlite" }); stores.push(store);
  store.registerProject({ id: "project_one", name: "test", root: "/tmp" });
  for (const id of ["session_host", "session_worker", "session_observer"]) store.createSession({ id, projectId: "project_one" });
  store.submitTurn("session_worker", { runId: "run_source", input: "work" });
  const claimToken = store.claimTurn("session_worker", "worker_one")!.claim!.token;
  store.markRunning("session_worker", "run_source", claimToken);
  return { store, home, proof: { sessionId: "session_worker", runId: "run_source", claimToken } };
}
test("routine reports are durable activity, never a claimed run or a notification cascade", () => {
  const { store, home, proof } = setup();
  store.subscribe("session_observer", { targetSessionId: "session_host" });
  store.subscribe("session_host", { targetSessionId: "session_worker", once: true });
  const report = store.submitAgentTurn("session_host", { runId: "run_report", input: "routine progress" }, proof);
  expect(report.turn).toMatchObject({ state: "completed", agentIntent: "report", agentDelivery: "passive" });
  expect(store.claimTurn("session_host", "worker_two")).toBeUndefined();
  expect(store.turns("session_observer")).toHaveLength(0);
  expect(store.subscriptionsFor("session_host")).toHaveLength(1);
  store.closeExecutionStore();
  const reopened = new EngineStore(home); stores.push(reopened);
  expect(reopened.turns("session_host")[0]?.agentDelivery).toBe("passive");
  expect(reopened.claimTurn("session_host", "worker_two")).toBeUndefined();
});
test("a routine report never steers an already running coordinator", () => {
  const { store, proof } = setup();
  store.submitTurn("session_host", { runId: "run_host", input: "coordinate" });
  const token = store.claimTurn("session_host", "worker_two")!.claim!.token;
  store.markRunning("session_host", "run_host", token);
  store.submitAgentTurn("session_host", { runId: "run_report", input: "progress", intent: "report" }, proof);
  expect(store.steerForWorker("worker_two")).toHaveLength(0);
  expect(store.turns("session_host").find(t => t.runId === "run_host")?.state).toBe("running");
});
test("an awaited result wakes once, consumes its subscription, and is not repeated at completion", () => {
  const { store, proof } = setup();
  store.subscribe("session_host", { targetSessionId: "session_worker", once: true });
  const input = { runId: "run_result", input: "finished", intent: "result" as const };
  const result = store.submitAgentTurn("session_host", input, proof);
  expect(result.turn.agentDelivery).toBe("wake");
  expect(store.subscriptionsFor("session_host")).toHaveLength(0);
  expect(store.submitAgentTurn("session_host", input, proof).replayed).toBe(true);
  store.completeTurn("session_worker", "run_source", proof.claimToken, { text: "finished" });
  expect(store.turns("session_host")).toHaveLength(1);
  expect(store.claimTurn("session_host", "worker_two")?.runId).toBe("run_result");
});
test("an unawaited result is passive; a blocker wakes but never overrides human Stop", () => {
  const { store, proof } = setup();
  expect(store.submitAgentTurn("session_host", { runId: "run_result", input: "FYI", intent: "result" }, proof).turn.agentDelivery).toBe("passive");
  expect(store.submitAgentTurn("session_host", { runId: "run_blocker", input: "need intervention", intent: "blocker" }, proof).turn.agentDelivery).toBe("wake");
  store.stopSession("session_host", "user");
  expect(() => store.submitAgentTurn("session_host", { runId: "run_again", input: "urgent", intent: "blocker" }, proof)).toThrow("stopped by its user");
  expect(store.claimTurn("session_host", "worker_two")).toBeUndefined();
});
test("persistent monitoring also suppresses duplicate completion after an explicit result", () => {
  const { store, proof } = setup();
  store.subscribe("session_host", { targetSessionId: "session_worker", once: false });
  store.submitAgentTurn("session_host", { runId: "run_result", input: "finished", intent: "result" }, proof);
  store.completeTurn("session_worker", "run_source", proof.claimToken, { text: "finished" });
  expect(store.subscriptionsFor("session_host")).toHaveLength(1);
  expect(store.turns("session_host")).toHaveLength(1);
});
