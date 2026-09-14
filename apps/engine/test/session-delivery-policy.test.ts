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
/**
 * #240, SEEN TWICE IN ONE DAY: a worker sends a result MID-TASK — "here is the
 * part I finished" — and keeps working. That result used to spend the
 * coordinator's one-shot subscription AND suppress the run's `turn_completed`,
 * so the errand never closed: the coordinator sat holding an interim answer,
 * waiting for an end that had been thrown away twice over.
 */
test("an interim result does not spend the one-shot, and the completion that follows still wakes", () => {
  const { store, proof } = setup();
  store.subscribe("session_host", { targetSessionId: "session_worker", once: true });
  const input = { runId: "run_result", input: "finished", intent: "result" as const };
  const result = store.submitAgentTurn("session_host", input, proof);
  expect(result.turn.agentDelivery).toBe("wake");
  // Still live: only an ENDING spends it.
  expect(store.subscriptionsFor("session_host")).toHaveLength(1);
  expect(store.submitAgentTurn("session_host", input, proof).replayed).toBe(true);
  store.completeTurn("session_worker", "run_source", proof.claimToken, { text: "finished" });
  // BOTH facts land, in order: what the worker produced, then that its run ended.
  const received = store.turns("session_host");
  expect(received).toHaveLength(2);
  expect(received[0]).toMatchObject({ runId: "run_result", agentIntent: "result" });
  expect(received[1]?.wakeReason).toMatchObject({ kind: "turn_completed", sessionId: "session_worker", runId: "run_source" });
  // The terminal event is what spent it.
  expect(store.subscriptionsFor("session_host")).toHaveLength(0);
});

test("a parked request does not spend a one-shot — the target is waiting, not finished", () => {
  const { store, proof } = setup();
  store.subscribe("session_host", { targetSessionId: "session_worker", once: true });
  store.openRequest("session_worker", "run_source", proof.claimToken, {
    requestId: "req_ask",
    kind: "user_input",
    detail: { kind: "user_input", prompt: "Wait or continue?", fields: [{ key: "choice", label: "Choice", kind: "choice", choices: ["Wait", "Continue"] }] },
  });
  expect(store.turns("session_host")[0]?.wakeReason).toMatchObject({ kind: "request_opened", requestId: "req_ask" });
  expect(store.subscriptionsFor("session_host")).toHaveLength(1);
  store.resolveRequest("session_worker", "req_ask", { decision: "accept" });
  store.completeTurn("session_worker", "run_source", proof.claimToken, { text: "done" });
  expect(store.turns("session_host").at(-1)?.wakeReason).toMatchObject({ kind: "turn_completed" });
  expect(store.subscriptionsFor("session_host")).toHaveLength(0);
});
test("an unawaited result is passive; a blocker wakes but never overrides human Stop", () => {
  const { store, proof } = setup();
  expect(store.submitAgentTurn("session_host", { runId: "run_result", input: "FYI", intent: "result" }, proof).turn.agentDelivery).toBe("passive");
  expect(store.submitAgentTurn("session_host", { runId: "run_blocker", input: "need intervention", intent: "blocker" }, proof).turn.agentDelivery).toBe("wake");
  store.stopSession("session_host", "user");
  expect(() => store.submitAgentTurn("session_host", { runId: "run_again", input: "urgent", intent: "blocker" }, proof)).toThrow("stopped by its user");
  expect(store.claimTurn("session_host", "worker_two")).toBeUndefined();
});
test("persistent monitoring hears the completion too, and keeps its subscription", () => {
  const { store, proof } = setup();
  store.subscribe("session_host", { targetSessionId: "session_worker", once: false });
  store.submitAgentTurn("session_host", { runId: "run_result", input: "finished", intent: "result" }, proof);
  store.completeTurn("session_worker", "run_source", proof.claimToken, { text: "finished" });
  // `once: false` is ongoing monitoring by definition — it survives either way.
  expect(store.subscriptionsFor("session_host")).toHaveLength(1);
  expect(store.turns("session_host")).toHaveLength(2);
});
