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
  // A resolvable model, so `claimNextTurn` can build a claim (held mail rides its notes).
  fs.writeFileSync(path.join(home, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  const store = new EngineStore(home, Date.now); stores.push(store);
  store.registerProject({ id: "project_one", name: "test", root: "/tmp" });
  for (const id of ["session_host", "session_worker", "session_observer"]) store.createSession({ id, projectId: "project_one" });
  store.submitTurn("session_worker", { runId: "run_source", input: "work" });
  const claimToken = store.claimTurn("session_worker", "worker_one")!.claim!.token;
  store.markRunning("session_worker", "run_source", claimToken);
  return { store, home, proof: { sessionId: "session_worker", runId: "run_source", claimToken } };
}
/** Make the recipient BUSY (a report is passive either way since the
 *  session-tools audit). Hands back the claim so a test can settle it. */
function busy(store: EngineStore, runId = "run_host"): string {
  store.submitTurn("session_host", { runId, input: "a long think" });
  const token = store.claimTurn("session_host", "worker_two")!.claim!.token;
  store.markRunning("session_host", runId, token);
  return token;
}

test("routine reports are durable activity, never a claimed run or a notification cascade", () => {
  const { store, home, proof } = setup();
  store.subscribe("session_observer", { targetSessionId: "session_host" });
  store.subscribe("session_host", { targetSessionId: "session_worker", once: true });
  // BUSY IS WHAT MAKES IT PASSIVE NOW (#631 part 2). The cost `passive` exists
  // to refuse is interrupting a coordinator mid-reasoning, and that is exactly
  // this: a routine report must not steer, claim, or cascade into one.
  busy(store);
  const report = store.submitAgentTurn("session_host", { runId: "run_report", input: "routine progress" }, proof);
  expect(report.turn).toMatchObject({ state: "completed", agentIntent: "report", agentDelivery: "passive" });
  expect(store.claimTurn("session_host", "worker_three")).toBeUndefined();
  expect(store.turns("session_observer")).toHaveLength(0);
  expect(store.subscriptionsFor("session_host")).toHaveLength(1);
  store.closeExecutionStore();
  const reopened = new EngineStore(home); stores.push(reopened);
  expect(reopened.turns("session_host").find((turn) => turn.runId === "run_report")?.agentDelivery).toBe("passive");
});

/**
 * A REPORT NEVER OPENS A TURN, EVEN ON AN IDLE RECIPIENT — the session-tools
 * audit, inverting #631 part 2. Waking an idle coordinator for a progress note
 * cost a turn whose whole content was "noted". The report is held instead, and
 * handed over as a note on whatever turn starts next — here, the person's own
 * (`claimNextTurn` is where the note rides).
 */
test("a report to an IDLE session is held, and rides the next turn as a note", () => {
  const { store, proof } = setup();
  const report = store.submitAgentTurn("session_host", { runId: "run_report", input: "routine progress" }, proof);
  expect(report.turn).toMatchObject({ state: "completed", agentIntent: "report", agentDelivery: "passive" });
  expect(report.turn.sender).toEqual({ sessionId: "session_worker" });
  // Nothing to claim: no turn was opened for it.
  expect(store.claimTurn("session_host", "worker_two")).toBeUndefined();
  expect(store.pendingNotifications("session_host")).toHaveLength(1);

  store.submitTurn("session_host", { runId: "run_person", input: "what's new?" });
  const claim = store.claimNextTurn("worker_two")!;
  expect(claim.turn.runId).toBe("run_person");
  expect(claim.notes!.join("\n")).toContain("Held for you while you were busy; no reply needed.");
  expect(store.pendingNotifications("session_host")).toHaveLength(0);
});

/**
 * HELD PEER MAIL IS NOT FLUSHED INTO A TURN WHEN THE BUSY TURN ENDS — the
 * session-tools audit, inverting the idle-transition flush. Three reports during
 * a long turn stay in the mailbox and arrive together, as ONE note, on the next
 * turn that is claimed.
 */
test("messages held during a long turn stay held when it ends, and arrive together on the next turn", () => {
  const { store, proof } = setup();
  const token = busy(store);
  for (const n of [1, 2, 3]) {
    const held = store.submitAgentTurn("session_host", { runId: `run_report_${n}`, input: `progress ${n}`, intent: "report" }, proof);
    expect(held.turn.agentDelivery).toBe("passive");
  }
  expect(store.pendingNotifications("session_host")).toHaveLength(3);

  store.completeTurn("session_host", "run_host", token, { text: "done" });

  expect(store.turns("session_host").filter((turn) => turn.state === "queued")).toHaveLength(0);
  expect(store.pendingNotifications("session_host")).toHaveLength(3);

  store.submitTurn("session_host", { runId: "run_person", input: "next" });
  const notes = store.claimNextTurn("worker_two")!.notes!;
  const held = notes.filter((note) => note.startsWith("Held for you while you were busy"));
  expect(held).toHaveLength(1);
  expect(store.pendingNotifications("session_host")).toHaveLength(0);
});

test("a single held message says it was held, and the message row itself is untouched", () => {
  const { store, proof } = setup();
  const token = busy(store);
  store.submitAgentTurn("session_host", { runId: "run_one", input: "progress", intent: "report" }, proof);
  store.completeTurn("session_host", "run_host", token, { text: "done" });
  store.submitTurn("session_host", { runId: "run_person", input: "next" });
  const notes = store.claimNextTurn("worker_two")!.notes!;
  expect(notes.some((note) => note.startsWith("Held for you while you were busy; no reply needed."))).toBe(true);
  // The body it points at is still the message, untouched and unabridged.
  expect(store.turns("session_host").find((turn) => turn.runId === "run_one")!.input).toBe("progress");
});

test("a shelved or snoozed session is not un-shelved by a peer's routine report", () => {
  // THE ONE DELIBERATE EXCLUSION. `wakeSessionForNewWork` treats new work as the
  // shelf lifting itself, and a peer's report is not a person changing their
  // mind about a row they put away. The message is still recorded and still
  // rowed; it simply does not start anything.
  const { store, proof } = setup();
  store.updateSession("session_host", { settledOverride: "settled" });
  const shelved = store.submitAgentTurn("session_host", { runId: "run_shelved", input: "progress" }, proof);
  expect(shelved.turn.agentDelivery).toBe("passive");
  expect(store.getSession("session_host").settledOverride).toBe("settled");
  expect(store.claimTurn("session_host", "worker_two")).toBeUndefined();
  // And it is not lost either — it waits in the mailbox where `sessions_status`
  // reports it, rather than being dropped.
  expect(store.pendingNotifications("session_host")).toHaveLength(1);
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

/**
 * #919 — THE HALF #590 COULD NOT REACH. The merge above folds the completion
 * into a result still WAITING; once the coordinator has claimed the result the
 * turn is in front of a model and the merge misses. Measured seven times: the
 * coordinator was then woken a second time to say "already integrated". Now a
 * `result` is a run's final word, and the completion of a run whose result the
 * coordinator has read is recorded on its transcript and delivered to nobody.
 */
test("a result the coordinator has read is that run's last word: its completion is recorded, not delivered", () => {
  const { store, proof } = setup();
  store.subscribe("session_host", { targetSessionId: "session_worker", once: true });
  const result = store.submitAgentTurn("session_host", { runId: "run_result", input: "finished", intent: "result" }, proof);
  expect(result.turn.agentDelivery).toBe("wake");
  // The coordinator takes the result and finishes with it BEFORE the worker's
  // run ends — the ordering in every one of the measured transcripts.
  const token = store.claimTurn("session_host", "worker_two")!.claim!.token;
  store.markRunning("session_host", "run_result", token);
  store.completeTurn("session_host", "run_result", token, { text: "integrated" });

  store.completeTurn("session_worker", "run_source", proof.claimToken, { text: "finished" });

  // Two turns, both over: the result it read, and the record that the run
  // ended. Nothing queued, nothing held, nothing for a worker to claim.
  const turns = store.turns("session_host");
  expect(turns.map((turn) => turn.state)).toEqual(["completed", "completed"]);
  expect(turns[1]).toMatchObject({
    agentDelivery: "passive",
    wakeReason: { kind: "turn_completed", sessionId: "session_worker", runId: "run_source" },
  });
  expect(turns[1]!.notification!.body).toContain("turn run_source completed");
  expect(store.pendingNotifications("session_host")).toHaveLength(0);
  expect(store.claimTurn("session_host", "worker_two")).toBeUndefined();
  // The ending spent the one-shot, exactly as a delivered wake would have.
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
  // Busy, because that is what passive means since #631 part 2 — nobody is
  // waiting on this result, so it must not interrupt the turn in flight.
  busy(store);
  expect(store.submitAgentTurn("session_host", { runId: "run_result", input: "FYI", intent: "result" }, proof).turn.agentDelivery).toBe("passive");
  expect(store.submitAgentTurn("session_host", { runId: "run_blocker", input: "need intervention", intent: "blocker" }, proof).turn.agentDelivery).toBe("wake");
  store.stopSession("session_host", "user");
  expect(() => store.submitAgentTurn("session_host", { runId: "run_again", input: "urgent", intent: "blocker" }, proof)).toThrow("stopped by its user");
  expect(store.claimTurn("session_host", "worker_two")).toBeUndefined();
});
/**
 * A HUMAN STOP LATCHES OUT A PEER until the person speaks on that session
 * again, and the stamp of when rides with the latch and clears with it.
 */
test("a human Stop latches out a peer session until the person speaks again", () => {
  const { store, proof } = setup();
  store.stopSession("session_host", "user");
  expect(typeof store.getSession("session_host").agentMessagesBlockedAt).toBe("number");
  expect(() => store.submitAgentTurn("session_host", { runId: "run_peer", input: "carry on", intent: "task" }, proof)).toThrow("stopped by its user");
  expect(store.getSession("session_host").agentMessagesBlocked).toBe(true);

  // The person speaking clears both the latch and its stamp.
  store.submitTurn("session_host", { runId: "run_human", input: "go on then" });
  expect(store.getSession("session_host").agentMessagesBlocked).toBeUndefined();
  expect(store.getSession("session_host").agentMessagesBlockedAt).toBeUndefined();
  expect(store.submitAgentTurn("session_host", { runId: "run_peer_ok", input: "back on", intent: "task" }, proof).turn.state).toBe("queued");
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
