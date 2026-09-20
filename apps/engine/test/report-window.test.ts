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
import { HOLD_REPORTS } from "@telar/engine-client";
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

/* ══════════════════════════════════════════════════════════════════════════ *
 * THE WINDOW THAT NEVER CLOSES — issue #784, step 2.
 *
 * A window ends in a FLUSH and a flush is a TURN. For a peer that is exactly
 * right: the recipient is a model and being told IS the point. For a PERSON'S
 * session it means the cadence changes the count and not the kind — the
 * conversation still gains a row, a provider call is still paid against context
 * they will re-read cold, and whatever they were reading still moves. Forty
 * wakes becoming eight is a smaller version of the thing that was asked to stop,
 * and set overnight it delivers at 3:14am, 3:41am and 4:09am.
 *
 * SO `HOLD_REPORTS` IS A CADENCE WITH NO FLUSH IN IT. The mailbox is the
 * delivery, and the count the Agents panel already draws is how a person sees
 * it.
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * THE NEGATIVE AND THE POSITIVE ON ONE FIXTURE, and that is the point of the
 * test rather than a convenience. A suite that only asserted "no turn" would
 * pass if the sweep never ran at all — so the same store, the same mailbox and
 * the same elapsed clock are swept twice, and the only thing that changes
 * between them is the cadence.
 */
test("a held cadence is never flushed by the tick, and the same fixture flushes the moment it is a window", () => {
  const { store, clock, proof } = setup();
  store.updateSession("session_host", { reportWindowMinutes: HOLD_REPORTS });
  const turnsBefore = store.turns("session_host").length;
  for (const n of [1, 2, 3]) report(store, proof, `run_report_${n}`, `progress ${n}`);
  expect(store.pendingNotifications("session_host")).toHaveLength(3);

  // A DAY PAST ANY WINDOW THE ENGINE WILL TAKE. Nothing is due, because nothing
  // is ever due: there is no clause to satisfy.
  clock.now = START + 25 * 60 * MINUTE;
  expect(store.sweepReportWindows()).toEqual([]);
  // THE TURN COUNT, NOT THE DELIVERY FIELD. No turn was created — which is the
  // whole claim — and no provider call could have been paid for one.
  expect(store.turns("session_host")).toHaveLength(turnsBefore + 3);
  expect(queued(store)).toHaveLength(0);
  // AND NOTHING WAS LOST. This is the count the Agents panel draws and
  // `sessions_status` reports; "held" and "lost" look identical without it.
  expect(store.pendingNotifications("session_host")).toHaveLength(3);

  /**
   * NOW THE POSITIVE, ON THE SAME BOX. One field changes and the same sweep at
   * the same instant delivers all three as one merged turn — so the `[]` above
   * was a decision about this session and not a sweep that was asleep.
   */
  store.updateSession("session_host", { reportWindowMinutes: 25 });
  expect(store.sweepReportWindows()).toEqual(["session_host"]);
  const delivered = queued(store);
  expect(delivered).toHaveLength(1);
  expect(delivered[0]!.notification!.entries!.map((entry) => entry.kind)).toEqual(["peer_message", "peer_message", "peer_message"]);
  expect(store.pendingNotifications("session_host")).toHaveLength(0);
});

test("a task, a blocker and an awaited result still arrive at once under a hold", () => {
  // THE ONE WAY THIS COULD MAKE THINGS WORSE. A cadence that swallowed a
  // blocker would turn the single message that should interrupt into the one
  // that waits for somebody to open the app.
  const { store, proof } = setup();
  store.updateSession("session_host", { reportWindowMinutes: HOLD_REPORTS });
  store.subscribe("session_host", { targetSessionId: "session_worker", once: true });
  report(store, proof, "run_held");

  for (const [runId, intent] of [["run_task", "task"], ["run_blocker", "blocker"], ["run_result", "result"]] as const) {
    store.submitAgentTurn("session_host", { runId, input: intent, intent }, proof);
  }
  // Three arrived and the routine report did not — counted on the queue rather
  // than read off `agentDelivery`.
  expect(queued(store).map((turn) => turn.runId)).toEqual(["run_task", "run_blocker", "run_result"]);
  expect(store.pendingNotifications("session_host")).toHaveLength(1);
});

test("a held session that takes a turn of its own still drains its box at the end of it", () => {
  /**
   * THE HOLD IS ON THE TICK, NOT ON THE FLUSH — the same split the shelf has.
   * A session that ENDS A TURN is awake by demonstration, and the four
   * turn-boundary drains are untouched: a person who actually speaks to this
   * session gets their mail, merged, at a moment they were already paying for.
   * Without this, "held" would mean "held for ever even while you are reading",
   * which is a different and worse feature.
   */
  const { store, proof } = setup();
  store.updateSession("session_host", { reportWindowMinutes: HOLD_REPORTS });
  report(store, proof, "run_report");
  expect(store.pendingNotifications("session_host")).toHaveLength(1);

  store.submitTurn("session_host", { runId: "run_host", input: "what is going on?" });
  const token = store.claimTurn("session_host", "worker_two")!.claim!.token;
  store.markRunning("session_host", "run_host", token);
  store.completeTurn("session_host", "run_host", token, { text: "done" });
  expect(store.pendingNotifications("session_host")).toHaveLength(0);
  expect(queued(store)).toHaveLength(1);
});

test("the cadence takes the hold value, refuses anything else, and null still turns it off", () => {
  const { store } = setup();
  expect(store.updateSession("session_host", { reportWindowMinutes: HOLD_REPORTS }).reportWindowMinutes).toBe(HOLD_REPORTS);
  // The number range is unchanged beside it, in both directions.
  expect(store.updateSession("session_host", { reportWindowMinutes: 1440 }).reportWindowMinutes).toBe(1440);
  for (const bad of ["never", "HOLD", "0", "", 0, 1441]) {
    expect(() => store.updateSession("session_host", { reportWindowMinutes: bad as never })).toThrow(EngineStateError);
  }
  // Still 1440 — a refused patch changes nothing.
  expect(store.getSession("session_host").reportWindowMinutes).toBe(1440);
  expect(store.updateSession("session_host", { reportWindowMinutes: null }).reportWindowMinutes).toBeUndefined();
});

test("turning a hold off does not itself deliver, and it survives a restart holding its mail", () => {
  const { store, home, clock, proof } = setup();
  store.updateSession("session_host", { reportWindowMinutes: HOLD_REPORTS });
  report(store, proof, "run_report");
  // A person adjusting a cadence must not thereby hand the session a turn —
  // #723's rule, which this value inherits rather than re-decides.
  store.updateSession("session_host", { reportWindowMinutes: null });
  expect(store.pendingNotifications("session_host")).toHaveLength(1);
  expect(queued(store)).toHaveLength(0);

  store.updateSession("session_host", { reportWindowMinutes: HOLD_REPORTS });
  store.closeExecutionStore();
  stores.splice(stores.indexOf(store), 1);

  clock.now = START + 25 * 60 * MINUTE;
  const reopened = new EngineStore(home, () => clock.now);
  stores.push(reopened);
  expect(reopened.getSession("session_host").reportWindowMinutes).toBe(HOLD_REPORTS);
  expect(reopened.pendingNotifications("session_host")).toHaveLength(1);
  expect(reopened.sweepReportWindows()).toEqual([]);
  expect(queued(reopened)).toHaveLength(0);
});
