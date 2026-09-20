/**
 * A RECIPIENT MAY ASK TO BE TOLD ON A CLOCK — the report cadence, issue #723.
 *
 * `session-delivery-policy.test.ts` is the policy this extends and does not
 * replace: a routine report to a BUSY session is held and merged (#550), and to
 * an IDLE one it is delivered rather than lost (#631 part 2). That second rule is
 * right for one sender and unreadable for five — five workers wake an idle
 * coordinator five times, and the interleaving is what made hand-run
 * orchestration illegible.
 *
 * SO A WINDOW WITHDRAWS EXACTLY ONE CLAUSE, and these tests are mostly about
 * what it must NOT touch: a task, a blocker and an awaited result still arrive at
 * once, a session with no window behaves precisely as it did, and nothing is
 * delivered into the middle of a running turn.
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

const START = 1_700_000_000_000;
const MINUTE = 60_000;

/** Two sessions, a live claim on the sender — the proof `Turn.sender` is stamped
 *  from — and a clock a test can wind forward. */
function setup(windowMinutes?: number) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-window-"));
  homes.push(home);
  const clock = { now: START };
  const store = new EngineStore(home, () => clock.now, { executionStorage: "sqlite" });
  stores.push(store);
  store.registerProject({ id: "project_one", name: "test", root: "/tmp" });
  for (const id of ["session_host", "session_worker"]) store.createSession({ id, projectId: "project_one" });
  store.submitTurn("session_worker", { runId: "run_source", input: "work" });
  const claimToken = store.claimTurn("session_worker", "worker_one")!.claim!.token;
  store.markRunning("session_worker", "run_source", claimToken);
  if (windowMinutes !== undefined) store.updateSession("session_host", { reportWindowMinutes: windowMinutes });
  return { store, home, clock, proof: { sessionId: "session_worker", runId: "run_source", claimToken } };
}

/** Turns waiting to be run. A held cohort's delivery is one of these; a passive
 *  arrival is never one, because it completed on the way in. */
const queued = (store: EngineStore, sessionId = "session_host") =>
  store.turns(sessionId).filter((turn) => turn.state === "queued");

const report = (store: EngineStore, proof: Parameters<EngineStore["submitAgentTurn"]>[2], runId: string, input = "progress") =>
  store.submitAgentTurn("session_host", { runId, input, intent: "report" }, proof);

test("a routine report to an IDLE recipient with a window is held, not delivered", () => {
  const { store, proof } = setup(25);
  const held = report(store, proof, "run_report");
  // The message is recorded whole and completed on arrival — no claim, no
  // provider call, which is #199's "no extra model invocation for passive
  // reports" and the reason a window costs nothing to hold.
  expect(held.turn).toMatchObject({ state: "completed", agentIntent: "report", agentDelivery: "passive" });
  expect(held.turn.input).toBe("progress");
  expect(store.pendingNotifications("session_host")).toHaveLength(1);
  expect(store.claimTurn("session_host", "worker_two")).toBeUndefined();
});

test("several reports inside one window arrive as ONE turn when it closes", () => {
  const { store, clock, proof } = setup(25);
  for (const n of [1, 2, 3]) {
    // Spread across the window: a later report must not push the delivery back,
    // or a steady trickle would hold the box open indefinitely.
    clock.now = START + n * 5 * MINUTE;
    expect(report(store, proof, `run_report_${n}`, `progress ${n}`).turn.agentDelivery).toBe("passive");
  }
  expect(store.pendingNotifications("session_host")).toHaveLength(3);

  // Due measured from the FIRST hold: 25 minutes after the first report, not
  // after the third.
  clock.now = START + 5 * MINUTE + 25 * MINUTE;
  expect(store.sweepReportWindows()).toEqual(["session_host"]);

  const delivered = queued(store);
  expect(delivered).toHaveLength(1);
  expect(delivered[0]!.notification!.entries!.map((entry) => entry.kind)).toEqual(["peer_message", "peer_message", "peer_message"]);
  // A held peer message is not a wake: the turn carries its sender, so nothing
  // tells a surface that some run finished (#631 part 2).
  expect(delivered[0]!.wakeReason).toBeUndefined();
  expect(delivered[0]!.sender).toEqual({ sessionId: "session_worker" });
  expect(store.pendingNotifications("session_host")).toHaveLength(0);
  // Each body is still its own, unabridged, where it was stored.
  expect(store.turns("session_host").find((turn) => turn.runId === "run_report_2")!.input).toBe("progress 2");
});

test("the window is not due before it elapses", () => {
  const { store, clock, proof } = setup(25);
  report(store, proof, "run_report");
  clock.now = START + 24 * MINUTE;
  expect(store.sweepReportWindows()).toEqual([]);
  expect(store.pendingNotifications("session_host")).toHaveLength(1);
  expect(queued(store)).toHaveLength(0);
});

test("a window that closes with an empty box delivers nothing at all", () => {
  // A turn saying "no reports this window" is a model invocation paid for
  // silence. Absence of a delivery IS the report.
  const { store, clock } = setup(25);
  const before = store.turns("session_host").length;
  clock.now = START + 60 * MINUTE;
  expect(store.sweepReportWindows()).toEqual([]);
  expect(store.turns("session_host")).toHaveLength(before);
  expect(queued(store)).toHaveLength(0);
});

test("the next window is measured from the delivery, not from the close it missed", () => {
  const { store, clock, proof } = setup(25);
  report(store, proof, "run_first");
  clock.now = START + 25 * MINUTE;
  expect(store.sweepReportWindows()).toEqual(["session_host"]);

  // A fresh report opens a fresh window. Without the stamp being cleared on
  // flush, the already-elapsed clock would deliver this one immediately.
  report(store, proof, "run_second");
  expect(store.sweepReportWindows()).toEqual([]);
  expect(store.pendingNotifications("session_host")).toHaveLength(1);
  clock.now = START + 25 * MINUTE + 25 * MINUTE;
  expect(store.sweepReportWindows()).toEqual(["session_host"]);
});

test("a blocker is delivered at once, and does not take the held reports with it", () => {
  const { store, proof } = setup(25);
  report(store, proof, "run_report_1");
  report(store, proof, "run_report_2");

  const blocker = store.submitAgentTurn(
    "session_host",
    { runId: "run_blocker", input: "The build host is out of disk.", intent: "blocker" },
    proof,
  );
  expect(blocker.turn).toMatchObject({ state: "queued", agentIntent: "blocker", agentDelivery: "wake" });
  expect(queued(store).map((turn) => turn.runId)).toEqual(["run_blocker"]);
  // ARRIVAL IS NOT A DRAIN. The blocker is the only thing delivered; the routine
  // cohort stays in the box for its window, or for this turn's end — whichever
  // comes first, both of which are deliveries nobody has to ask for.
  expect(store.pendingNotifications("session_host")).toHaveLength(2);
});

test("a task still wakes a session that set a window", () => {
  const { store, proof } = setup(25);
  const task = store.submitAgentTurn("session_host", { runId: "run_task", input: "Build the thing", intent: "task" }, proof);
  expect(task.turn).toMatchObject({ state: "queued", agentDelivery: "wake" });
  expect(store.claimTurn("session_host", "worker_two")?.runId).toBe("run_task");
});

test("an AWAITED result still wakes, because a subscription is a request to be woken", () => {
  const { store, proof } = setup(25);
  store.subscribe("session_host", { targetSessionId: "session_worker", once: true });
  const result = store.submitAgentTurn("session_host", { runId: "run_result", input: "Done, here it is", intent: "result" }, proof);
  expect(result.turn).toMatchObject({ state: "queued", agentIntent: "result", agentDelivery: "wake" });
  // An UNAWAITED result is routine, so it is held like a report.
  const { store: other, proof: otherProof } = setup(25);
  const unawaited = other.submitAgentTurn("session_host", { runId: "run_result", input: "FYI", intent: "result" }, otherProof);
  expect(unawaited.turn.agentDelivery).toBe("passive");
});

test("a session with NO window behaves exactly as it does today", () => {
  // The positive control for every test above: without a window the idle
  // recipient takes the report on arrival, which is #631 part 2 unchanged.
  const { store, proof } = setup();
  const delivered = report(store, proof, "run_report");
  expect(delivered.turn).toMatchObject({ state: "queued", agentDelivery: "wake" });
  expect(store.claimTurn("session_host", "worker_two")?.runId).toBe("run_report");
});

test("a window closing mid-turn waits for the turn's end rather than interrupting it", () => {
  const { store, clock, proof } = setup(25);
  report(store, proof, "run_report");
  store.submitTurn("session_host", { runId: "run_host", input: "a long think" });
  const token = store.claimTurn("session_host", "worker_two")!.claim!.token;
  store.markRunning("session_host", "run_host", token);

  clock.now = START + 26 * MINUTE;
  // Due, but the session is thinking. Nothing is delivered and nothing is lost.
  expect(store.sweepReportWindows()).toEqual([]);
  expect(store.pendingNotifications("session_host")).toHaveLength(1);
  expect(store.steerForWorker("worker_two")).toHaveLength(0);

  // The turn's own end is the drain that was always there.
  store.completeTurn("session_host", "run_host", token, { text: "done" });
  expect(store.pendingNotifications("session_host")).toHaveLength(0);
  expect(queued(store)).toHaveLength(1);
});

test("the window and the mail it is holding both survive a restart", () => {
  const { store, home, clock, proof } = setup(25);
  report(store, proof, "run_report");
  store.closeExecutionStore();
  stores.splice(stores.indexOf(store), 1);

  clock.now = START + 26 * MINUTE;
  const reopened = new EngineStore(home, () => clock.now);
  stores.push(reopened);
  expect(reopened.getSession("session_host").reportWindowMinutes).toBe(25);
  expect(reopened.pendingNotifications("session_host")).toHaveLength(1);
  // And the clock survived with it: the cohort is due, so the sweep delivers.
  expect(reopened.sweepReportWindows()).toEqual(["session_host"]);
  expect(queued(reopened)).toHaveLength(1);
});

test("the window is a whole number of minutes inside its bounds, and null turns it off", () => {
  const { store } = setup();
  for (const bad of [0, -5, 1441, 2.5]) {
    expect(() => store.updateSession("session_host", { reportWindowMinutes: bad })).toThrow(EngineStateError);
  }
  expect(store.getSession("session_host").reportWindowMinutes).toBeUndefined();
  expect(store.updateSession("session_host", { reportWindowMinutes: 1 }).reportWindowMinutes).toBe(1);
  expect(store.updateSession("session_host", { reportWindowMinutes: 1440 }).reportWindowMinutes).toBe(1440);
  expect(store.updateSession("session_host", { reportWindowMinutes: null }).reportWindowMinutes).toBeUndefined();
});

test("turning the window off does not itself deliver what is held", () => {
  // A person adjusting a cadence setting must not thereby hand the session a
  // turn. The mail goes out at the next drain, which with no window is the very
  // next turn boundary.
  const { store, proof } = setup(25);
  report(store, proof, "run_report");
  store.updateSession("session_host", { reportWindowMinutes: null });
  expect(store.pendingNotifications("session_host")).toHaveLength(1);
  expect(queued(store)).toHaveLength(0);
  // And with the window off, the next report is delivered on arrival again —
  // taking the held one with it, as one merged turn.
  const next = report(store, proof, "run_next");
  expect(next.turn.agentDelivery).toBe("wake");
});

/**
 * THE REGRESSION THIS SWEEP COULD HAVE BEEN. `flushPendingNotifications` submits
 * a turn, and `submitTurn` treats new work as the shelf lifting itself — so the
 * first version of the tick un-shelved every settled session holding mail, which
 * is exactly the exclusion #631 part 2 made deliberate. The mailbox comment
 * promises a shelved session "holds it indefinitely"; on main nothing ever
 * called the flush on such a session, and this tick is the first thing that can.
 */
test("the tick does not deliver to a shelved or snoozed session, or un-shelve it", () => {
  for (const put of [{ settledOverride: "settled" as const }, { snoozedUntil: START + 60 * MINUTE }]) {
    const { store, clock, proof } = setup(25);
    store.updateSession("session_host", put);
    expect(report(store, proof, "run_report").turn.agentDelivery).toBe("passive");
    clock.now = START + 26 * MINUTE;
    expect(store.sweepReportWindows()).toEqual([]);
    // Still put away, and the mail still waiting where `sessions_status` reports
    // it rather than dropped.
    const after = store.getSession("session_host");
    expect(after.settledOverride).toBe(put.settledOverride);
    expect(after.snoozedUntil).toBe(put.snoozedUntil);
    expect(store.pendingNotifications("session_host")).toHaveLength(1);
    expect(queued(store)).toHaveLength(0);
  }
});
