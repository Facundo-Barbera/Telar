/**
 * PEER MAIL NEVER OPENS A TURN — the session-tools audit.
 *
 * A report, or a result nobody subscribed to, used to wake an idle recipient
 * (#631 part 2), and a report window (#723, #784) was the knob for holding them
 * instead. The coordinator paid for it either way: it finished its reply and
 * was woken again to read a progress note and answer "noted". Now peer mail is
 * always held and handed over with the recipient's next turn, whatever starts
 * it — a real wake, or the person's own message. A task, a blocker and an
 * awaited result still arrive at once; the window is retired.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStateError, EngineStore } from "../src/state";

const homes: string[] = [];
const stores: EngineStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.closeExecutionStore();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

/** Two sessions and a live claim on the sender — the proof `Turn.sender` is
 *  stamped from. */
function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-peer-mail-"));
  homes.push(home);
  // A Claude default this home already knows, so `claimNextTurn` is not withheld
  // waiting for a model list.
  fs.writeFileSync(path.join(home, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  const store = new EngineStore(home, () => 1_700_000_000_000, { executionStorage: "sqlite" });
  stores.push(store);
  store.registerProject({ id: "project_one", name: "test", root: "/tmp" });
  for (const id of ["session_host", "session_worker"]) store.createSession({ id, projectId: "project_one" });
  store.submitTurn("session_worker", { runId: "run_source", input: "work" });
  const claimToken = store.claimTurn("session_worker", "worker_one")!.claim!.token;
  store.markRunning("session_worker", "run_source", claimToken);
  return { store, proof: { sessionId: "session_worker", runId: "run_source", claimToken } };
}

type Proof = Parameters<EngineStore["submitAgentTurn"]>[2];
const queued = (store: EngineStore) => store.turns("session_host").filter((turn) => turn.state === "queued");
const send = (store: EngineStore, proof: Proof, runId: string, intent: "report" | "result" | "blocker" | "task", input = "progress") =>
  store.submitAgentTurn("session_host", { runId, input, intent }, proof);

test("a report to an IDLE recipient is held, and opens no turn", () => {
  const { store, proof } = setup();
  const held = send(store, proof, "run_report", "report");
  expect(held.turn).toMatchObject({ state: "completed", agentDelivery: "passive" });
  expect(store.pendingNotifications("session_host")).toHaveLength(1);
  expect(queued(store)).toHaveLength(0);
  expect(store.claimTurn("session_host", "worker_two")).toBeUndefined();
});

test("a result nobody subscribed to is mail too", () => {
  const { store, proof } = setup();
  expect(send(store, proof, "run_result", "result", "PR green.").turn.agentDelivery).toBe("passive");
  expect(queued(store)).toHaveLength(0);
});

test("the person's next message carries the held mail, as a note, in the same turn", () => {
  const { store, proof } = setup();
  send(store, proof, "run_one", "report", "tests written");
  send(store, proof, "run_two", "report", "CI running");
  store.submitTurn("session_host", { runId: "run_person", input: "how is it going?" });
  // The worker's claim is what the driver is handed; the notes ride on it.
  const claim = store.claimNextTurn("worker_two")!;
  expect(claim.turn.runId).toBe("run_person");
  const notes = claim.notes ?? [];
  expect(notes).toHaveLength(1);
  expect(notes[0]).toStartWith("Held for you while you were busy; no reply needed.");
  // Handed over once: the box is empty, and nothing else is queued.
  expect(store.pendingNotifications("session_host")).toHaveLength(0);
  expect(queued(store)).toHaveLength(0);
});

test("the end of the host's own turn does not turn held mail into a turn", () => {
  const { store, proof } = setup();
  store.submitTurn("session_host", { runId: "run_think", input: "a long think" });
  const token = store.claimTurn("session_host", "worker_two")!.claim!.token;
  store.markRunning("session_host", "run_think", token);
  send(store, proof, "run_report", "report");
  store.completeTurn("session_host", "run_think", token, { text: "done thinking" });
  // The complaint: finishing a reply, then being woken just to read "progress".
  expect(queued(store)).toHaveLength(0);
  expect(store.pendingNotifications("session_host")).toHaveLength(1);
});

test("held mail rides with the next real wake, as one notification", () => {
  const { store, proof } = setup();
  send(store, proof, "run_report", "report", "halfway");
  store.subscribe("session_host", { targetSessionId: "session_worker" });
  store.completeTurn("session_worker", "run_source", proof.claimToken, { text: "Stopped without a result." });
  const woken = queued(store);
  expect(woken).toHaveLength(1);
  expect(woken[0]!.notification!.entries?.map((entry) => entry.kind)).toEqual(["peer_message", "wake"]);
  expect(store.pendingNotifications("session_host")).toHaveLength(0);
});

test("a task, a blocker and an awaited result still arrive at once", () => {
  // One fixture each: two messages from one run fold into one delivery.
  const blocker = setup();
  expect(send(blocker.store, blocker.proof, "run_blocker", "blocker", "Which database?").turn.agentDelivery).toBe("wake");
  const task = setup();
  expect(send(task.store, task.proof, "run_task", "task", "review this").turn.agentDelivery).toBe("wake");
  const result = setup();
  result.store.subscribe("session_host", { targetSessionId: "session_worker" });
  expect(send(result.store, result.proof, "run_result", "result", "PR green.").turn.agentDelivery).toBe("wake");
});

test("only a task or a blocker steers into the host's running turn", () => {
  const { store, proof } = setup();
  store.subscribe("session_host", { targetSessionId: "session_worker" });
  store.submitTurn("session_host", { runId: "run_think", input: "a long think" });
  const token = store.claimTurn("session_host", "worker_two")!.claim!.token;
  store.markRunning("session_host", "run_think", token);
  expect(send(store, proof, "run_blocker", "blocker", "Which database?").turn.state).toBe("steering");
  // An awaited result waits for the turn to end rather than interrupting it.
  expect(send(store, proof, "run_result", "result", "PR green.").turn.state).toBe("queued");
});

test("report_window is retired: the tick delivers nothing", () => {
  const { store, proof } = setup();
  store.updateSession("session_host", { reportWindowMinutes: 5 });
  send(store, proof, "run_report", "report");
  expect(store.sweepReportWindows()).toEqual([]);
  expect(queued(store)).toHaveLength(0);
});

/**
 * A CORRECTION — issue #784, step 3, unchanged by the audit. Unread, the
 * earlier message is withdrawn and the correction takes its place; read, the
 * correction arrives at once.
 */
const correct = (store: EngineStore, proof: Proof, runId: string, corrects: string, intent: "report" | "result" = "report") =>
  store.submitAgentTurn("session_host", { runId, input: "the figure is 12, not 21", intent, corrects }, proof);

test("a correction to a message still WAITING as a wake replaces it", () => {
  const { store, proof } = setup();
  store.subscribe("session_host", { targetSessionId: "session_worker" });
  expect(send(store, proof, "run_wrong", "result").turn.state).toBe("queued");
  const fixed = correct(store, proof, "run_fixed", "run_wrong", "result");
  expect(queued(store).map((turn) => turn.runId)).toEqual(["run_fixed"]);
  expect(store.turns("session_host").find((turn) => turn.runId === "run_wrong")).toMatchObject({ state: "discarded" });
  expect(fixed.turn).toMatchObject({ corrects: "run_wrong", agentDelivery: "wake" });
  expect(fixed.turn.agentNotice).toContain("It CORRECTS their earlier message (run run_wrong); disregard that one.");
});

test("a correction to a message still HELD in the mailbox replaces it there", () => {
  const { store, proof } = setup();
  send(store, proof, "run_wrong", "report");
  expect(store.pendingNotifications("session_host").map((each) => each.runId)).toEqual(["run_wrong"]);
  correct(store, proof, "run_fixed", "run_wrong");
  expect(store.pendingNotifications("session_host").map((each) => each.runId)).toEqual(["run_fixed"]);
  expect(queued(store)).toHaveLength(0);
});

test("a correction to a message already READ arrives at once", () => {
  const { store, proof } = setup();
  store.subscribe("session_host", { targetSessionId: "session_worker", once: false });
  send(store, proof, "run_wrong", "result");
  const token = store.claimTurn("session_host", "worker_two")!.claim!.token;
  store.markRunning("session_host", "run_wrong", token);
  store.completeTurn("session_host", "run_wrong", token, { text: "noted 21" });
  const fixed = correct(store, proof, "run_fixed", "run_wrong");
  expect(fixed.turn.agentDelivery).toBe("wake");
  expect(queued(store).map((turn) => turn.runId)).toContain("run_fixed");
});

test("a correction can only name the sender's own earlier message to this session", () => {
  const { store, proof } = setup();
  store.submitTurn("session_host", { runId: "run_human", input: "a person's message" });
  expect(() => correct(store, proof, "run_fixed", "run_human")).toThrow(EngineStateError);
  expect(() => correct(store, proof, "run_fixed", "run_nothing")).toThrow("corrects must name an earlier message you sent to this session");
  send(store, proof, "run_wrong", "report");
  correct(store, proof, "run_fixed", "run_wrong");
  expect(correct(store, proof, "run_fixed", "run_wrong").replayed).toBe(true);
});
