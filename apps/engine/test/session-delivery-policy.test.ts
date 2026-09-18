import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore } from "../src/state";
import { AGENT_SELF_ID, type AgentSenderProof } from "../src/agent/identity";
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
 *
 * #590 FOLDED THE ROW, NOT THE FACT. The completion now rides the result still
 * waiting in the queue instead of queueing a second turn beside it — one row,
 * both facts, and the assertions below are about the second of them surviving,
 * which is the whole of what #240 protects.
 */
test("an interim result does not spend the one-shot, and the completion that follows still lands", () => {
  const { store, proof } = setup();
  store.subscribe("session_host", { targetSessionId: "session_worker", once: true });
  const input = { runId: "run_result", input: "finished", intent: "result" as const };
  const result = store.submitAgentTurn("session_host", input, proof);
  expect(result.turn.agentDelivery).toBe("wake");
  // Still live: only an ENDING spends it.
  expect(store.subscriptionsFor("session_host")).toHaveLength(1);
  expect(store.submitAgentTurn("session_host", input, proof).replayed).toBe(true);
  store.completeTurn("session_worker", "run_source", proof.claimToken, { text: "finished" });
  // BOTH facts land, in order: what the worker produced, then that its run
  // ended — as one notification the coordinator is handed once.
  const received = store.turns("session_host");
  expect(received).toHaveLength(1);
  expect(received[0]).toMatchObject({ runId: "run_result", agentIntent: "result" });
  const entries = received[0]!.notification!.entries!;
  expect(entries.map((entry) => entry.kind)).toEqual(["peer_message", "wake"]);
  expect(entries.at(-1)).toMatchObject({ wakeKind: "turn_completed", sessionId: "session_worker", runId: "run_source" });
  // And it is SAID, not merely filed: the notice the model reads carries the
  // ending, or the errand closes in the store and not in the coordinator.
  expect(received[0]!.notification!.body).toContain("turn run_source completed");
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
/**
 * #539 — THE STOP LATCH IS AIMED AT A PEER NOBODY IS WATCHING, and the built-in
 * Agent is the opposite of one.
 *
 * The latch exists for the orchestrator two rooms away that has not noticed the
 * person pressed Stop. The Agent has no errand of its own: every send it makes
 * is one a human asked for in the composer, seconds earlier, in front of them.
 * Both halves are asserted here, on one stopped session, because the whole
 * claim is that they DIFFER.
 */
test("a human Stop latches out a peer session and lets the built-in Agent through, saying so", () => {
  const { store, proof } = setup();
  store.stopSession("session_host", "user");
  const blockedAt = store.getSession("session_host").agentMessagesBlockedAt;
  expect(typeof blockedAt).toBe("number");

  // THE PEER: refused, exactly as before.
  expect(() => store.submitAgentTurn("session_host", { runId: "run_peer", input: "carry on", intent: "task" }, proof)).toThrow("stopped by its user");

  // THE AGENT: through — and told whose Stop it just stepped over, and when.
  const sent = store.submitAgentTurn("session_host", { runId: "run_agent", input: "the person asked me to", intent: "task" }, { sessionId: AGENT_SELF_ID });
  expect(sent.turn.state).toBe("queued");
  expect(sent.stoppedByUser).toEqual({ at: blockedAt });
  // No sender is stamped: the Agent is not a session, so a link to one would
  // be a dead end in every surface that draws this turn.
  expect(sent.turn.sender).toEqual({});
  expect(sent.turn.agentSourceRunId).toBeUndefined();

  // AND THE LATCH STILL STANDS. The Agent going through does not hold the door
  // for the peer behind it — only a human message on this session does that.
  expect(store.getSession("session_host").agentMessagesBlocked).toBe(true);
  expect(() => store.submitAgentTurn("session_host", { runId: "run_peer_again", input: "me too", intent: "task" }, proof)).toThrow("stopped by its user");

  // The person speaking clears both the latch and its stamp.
  store.submitTurn("session_host", { runId: "run_human", input: "go on then" });
  expect(store.getSession("session_host").agentMessagesBlocked).toBeUndefined();
  expect(store.getSession("session_host").agentMessagesBlockedAt).toBeUndefined();
  expect(store.submitAgentTurn("session_host", { runId: "run_peer_ok", input: "back on", intent: "task" }, proof).stoppedByUser).toBeUndefined();
});

/**
 * THE EXEMPTION IS A SHAPE, NOT A NAME — the two ways to reach for it wrongly.
 *
 * A claimless proof is the Agent's alone (a session has a claim and must show
 * it), and a CLAIMED proof may not borrow the Agent's reserved id — which is
 * the only form an HTTP body could take, since `AgentTurnInput` requires a run
 * id and a token.
 */
test("a claimless proof belongs to the Agent alone, and no claim may borrow its name", () => {
  const { store, proof } = setup();
  expect(() =>
    store.submitAgentTurn("session_host", { runId: "run_bare", input: "as the Agent" }, { sessionId: "session_worker" } as AgentSenderProof),
  ).toThrow("built-in Agent alone");
  expect(() =>
    store.submitAgentTurn("session_host", { runId: "run_forged", input: "as the Agent" }, { sessionId: AGENT_SELF_ID, runId: proof.runId, claimToken: proof.claimToken }),
  ).toThrow("not its own");
});

test("persistent monitoring hears the completion too, and keeps its subscription", () => {
  const { store, proof } = setup();
  store.subscribe("session_host", { targetSessionId: "session_worker", once: false });
  store.submitAgentTurn("session_host", { runId: "run_result", input: "finished", intent: "result" }, proof);
  store.completeTurn("session_worker", "run_source", proof.claimToken, { text: "finished" });
  // `once: false` is ongoing monitoring by definition — it survives either way.
  expect(store.subscriptionsFor("session_host")).toHaveLength(1);
  // ONE row since #590, and it is still told the run ended: the ending merged
  // into the result the host had not read yet.
  const received = store.turns("session_host");
  expect(received).toHaveLength(1);
  expect(received[0]!.notification!.entries?.at(-1)).toMatchObject({ wakeKind: "turn_completed", runId: "run_source" });
});
