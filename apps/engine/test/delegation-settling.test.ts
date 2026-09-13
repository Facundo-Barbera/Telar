/**
 * THE DELEGATION SETTLE, AS A FOLD — issue #378.
 *
 * The rule is five clauses and the risk is entirely in how they interact, so
 * they are tested where every case is three lines of facts rather than a whole
 * store. `delegation-settling-store.test.ts` is the other half: the same rule
 * over real turns, proving the engine actually GATHERS these facts.
 */
import { describe, expect, test } from "bun:test";
import type { SessionAssignment } from "@telar/engine-client";
import { delegationSettle, deliveryOf, newestAssignment, type DeliveryTurn } from "../src/delegation-settling";

const HOUR = 60 * 60 * 1000;
const NOW = 1_000 * HOUR;
const DELEGATE = "session_worker";
const COORD = "session_coord";

const assignment = (overrides: Partial<SessionAssignment> = {}): SessionAssignment => ({
  taskRunId: "run_task",
  fromSessionId: COORD,
  receivedAt: NOW - 10 * HOUR,
  runId: "run_task",
  outcome: "completed",
  endedAt: NOW - 5 * HOUR,
  ...overrides,
});

/** A `result` landing on the coordinator — the delivery signal `fireSubscriptions` dedupes on. */
const resultTurn = (runId: string, at = NOW - 4 * HOUR): DeliveryTurn => ({
  runId: "run_coord_reads",
  origin: "session",
  state: "completed",
  sender: { sessionId: DELEGATE },
  agentIntent: "result",
  agentSourceRunId: runId,
  acceptedAt: at,
});

/** A wake about that run, and the coordinator turn that consumed it. */
const wakeTurn = (runId: string, state: string, completedAt?: number): DeliveryTurn => ({
  runId: "run_coord_wake",
  origin: "session",
  state,
  wakeReason: { sessionId: DELEGATE, runId },
  acceptedAt: NOW - 5 * HOUR,
  ...(completedAt === undefined ? {} : { completedAt }),
});

const facts = (overrides: Partial<Parameters<typeof delegationSettle>[0]> = {}) =>
  delegationSettle({
    now: NOW,
    graceHours: 1,
    delegateSessionId: DELEGATE,
    assignments: [assignment()],
    coordinatorTurns: [resultTurn("run_task")],
    activity: "idle" as const,
    archived: false,
    unsettledAssignments: [],
    ...overrides,
  });

describe("newestAssignment — by position, because that is what the fold promises", () => {
  test("the last one wins, and an empty hand is nobody's delegate", () => {
    const first = assignment({ taskRunId: "run_a", runId: "run_a" });
    const second = assignment({ taskRunId: "run_b", runId: "run_b" });
    expect(newestAssignment([first, second])?.taskRunId).toBe("run_b");
    expect(newestAssignment([])).toBeUndefined();
  });
});

describe("deliveryOf — the two ways a coordinator can have taken it", () => {
  test("a result naming the run is delivery, dated by when it landed", () => {
    expect(deliveryOf(assignment(), DELEGATE, [resultTurn("run_task", NOW - 3 * HOUR)])).toBe(NOW - 3 * HOUR);
  });

  test("a result about ANOTHER run is not delivery of this one", () => {
    // The same pair `fireSubscriptions` dedupes on. Matching on the sender
    // alone would let a delegate's chatter about last week's errand settle
    // this one.
    expect(deliveryOf(assignment(), DELEGATE, [resultTurn("run_something_else")])).toBeUndefined();
  });

  test("a result from ANOTHER session is not delivery either", () => {
    const stranger = { ...resultTurn("run_task"), sender: { sessionId: "session_stranger" } };
    expect(deliveryOf(assignment(), DELEGATE, [stranger])).toBeUndefined();
  });

  test("a CONSUMED wake counts, dated by when the coordinator's turn ended", () => {
    expect(deliveryOf(assignment(), DELEGATE, [wakeTurn("run_task", "completed", NOW - 2 * HOUR)])).toBe(NOW - 2 * HOUR);
  });

  test("a wake still queued, or one whose turn failed, is not delivery", () => {
    // Delivery is the coordinator having READ the outcome. A wake sitting in a
    // queue has told nobody anything, and a turn that failed did not finish
    // reading it.
    expect(deliveryOf(assignment(), DELEGATE, [wakeTurn("run_task", "queued")])).toBeUndefined();
    expect(deliveryOf(assignment(), DELEGATE, [wakeTurn("run_task", "failed", NOW - 2 * HOUR)])).toBeUndefined();
  });

  test("a DETACHED assignment needs no delivery — a human already decided", () => {
    const detached = assignment({ outcome: "detached", endedAt: NOW - 6 * HOUR });
    expect(deliveryOf(detached, DELEGATE, [])).toBe(NOW - 6 * HOUR);
  });

  test("the result is preferred over a wake, even when the wake landed first", () => {
    // Both are delivery; the result is the more specific fact, and taking the
    // later of two would make the grace depend on which order a coordinator
    // happened to process things in.
    const both = [wakeTurn("run_task", "completed", NOW - 2 * HOUR), resultTurn("run_task", NOW - 4 * HOUR)];
    expect(deliveryOf(assignment(), DELEGATE, both)).toBe(NOW - 4 * HOUR);
  });
});

describe("delegationSettle — the five clauses", () => {
  test("delivered, finished and past the grace: it settles, naming the coordinator and the errand", () => {
    const outcome = facts({ coordinatorTurns: [resultTurn("run_task", NOW - 2 * HOUR)] });
    expect(outcome.settle).toEqual({
      kind: "delegation",
      coordinatorSessionId: COORD,
      runId: "run_task",
      // `at` is WHEN DELIVERY HAPPENED. `settledAt` already records when the
      // shelf took it; a second copy of that would say nothing new.
      at: NOW - 2 * HOUR,
    });
  });

  test("inside the grace it does not settle, and says when it would", () => {
    const outcome = facts({ coordinatorTurns: [resultTurn("run_task", NOW - 10 * 60_000)] });
    expect(outcome.settle).toBeUndefined();
    expect(outcome.dueAt).toBe(NOW - 10 * 60_000 + HOUR);
  });

  test("A FAILED ASSIGNMENT KEEPS THE ROW. It is the one a coordinator may still owe something", () => {
    const outcome = facts({ assignments: [assignment({ outcome: "failed" })] });
    expect(outcome.settle).toBeUndefined();
    expect(outcome.dueAt).toBeUndefined();
  });

  test("a stopped assignment is finished, and settles", () => {
    expect(facts({ assignments: [assignment({ outcome: "stopped" })] }).settle).toBeDefined();
  });

  test("an OUTSTANDING assignment anywhere keeps the row — even another coordinator's", () => {
    const other = assignment({ taskRunId: "run_other", runId: "run_other", fromSessionId: "session_other" });
    delete (other as { outcome?: unknown }).outcome;
    // Newest last: the delivered one is still the newest, and it is still not
    // enough. "Every assignment it holds" means every one.
    expect(facts({ assignments: [other, assignment()] }).settle).toBeUndefined();
  });

  test("an UNRESOLVED assignment is not finished — absence of a record is not an outcome", () => {
    expect(facts({ assignments: [assignment({ unresolved: true })] }).settle).toBeUndefined();
  });

  test("no delivery, no settle, however long ago the work ended", () => {
    expect(facts({ coordinatorTurns: [] }).settle).toBeUndefined();
  });

  test("a parked request, a running turn and a queued one each keep the row", () => {
    for (const activity of ["blocked", "working", "queued"] as const) {
      expect(facts({ activity }).settle, activity).toBeUndefined();
    }
    // `monitoring` is background work nobody is waiting on, and it does not
    // block a hand settle either (`canSettle`) — so it does not block this.
    expect(facts({ activity: "monitoring" }).settle).toBeDefined();
  });

  test("a PIN keeps it, and an existing settle is not restamped as the engine's", () => {
    expect(facts({ settledOverride: "active" }).settle).toBeUndefined();
    expect(facts({ settledOverride: "settled" }).settle).toBeUndefined();
  });

  test("AN ERRAND A HUMAN TOOK BACK IS NEVER RE-SETTLED", () => {
    expect(facts({ unsettledAssignments: ["run_task"] }).settle).toBeUndefined();
    // Scoped to that errand: a different one is a different argument.
    expect(facts({ unsettledAssignments: ["run_older"] }).settle).toBeDefined();
  });

  test("NO GRACE MEANS OFF — nothing settles on its own", () => {
    const outcome = facts({ graceHours: null });
    expect(outcome.settle).toBeUndefined();
    expect(outcome.dueAt).toBeUndefined();
  });

  test("a session nobody handed work to is not a delegate", () => {
    expect(facts({ assignments: [] }).settle).toBeUndefined();
  });

  test("an archived row is already off every list, and cannot be written to anyway", () => {
    expect(facts({ archived: true }).settle).toBeUndefined();
  });

  test("delivery is measured on the NEWEST assignment, not on a delivered older one", () => {
    // The issue's "consumed the wake and immediately sent a new task" case,
    // in the fold: the new task is the newest, and clause 1 refuses it.
    const fresh = assignment({ taskRunId: "run_task_2", runId: "run_task_2" });
    delete (fresh as { outcome?: unknown }).outcome;
    expect(facts({ assignments: [assignment(), fresh] }).settle).toBeUndefined();
  });
});
