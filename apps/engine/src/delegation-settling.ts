/**
 * WHEN A DELEGATED CONVERSATION IS OVER — issue #378.
 *
 * "Conversations that get linked to an agent should be settled after the agent
 * is done with them." The engine answers that from facts it already stamps: an
 * assignment is a `task` turn (`assignmentsOf`), and a result reaching the
 * coordinator is a turn carrying `agentIntent: "result"` with the delegate's
 * run in `agentSourceRunId` — the very pair `fireSubscriptions` already
 * deduplicates on. Nothing here reads a word of anybody's text, and nothing
 * here asks a model.
 *
 * A PURE FOLD, SEPARATE FROM THE STORE, because the rule is five clauses whose
 * interactions are the whole risk and the store is the one place they cannot
 * be enumerated cheaply. Every case in the issue is a call to `delegationSettle`
 * with different facts.
 *
 * THE FIVE CLAUSES, IN THE ORDER THEY ARE EVALUATED:
 *
 *   1. EVERY ASSIGNMENT IS FINISHED — completed, stopped or detached. A FAILED
 *      assignment does not qualify: a delegate that fell over is the one row
 *      whose coordinator may still need to do something about it, and shelving
 *      it is exactly the hiding this feature must not do. It stays until a
 *      human settles it or the quiet clock does.
 *   2. THE COORDINATOR HAS TAKEN DELIVERY of the newest assignment — see
 *      `deliveryOf`. Handing work over and never hearing back is not "done".
 *   3. NOTHING IS PARKED ON IT, IT IS NOT WORKING, AND NO BACKGROUND WORK IS
 *      STILL RUNNING. The precedence every other settling rule is built on
 *      (`isSettled`'s first clause, and its refusal to let the CLOCK shelve
 *      live background work): the worst outcome of any rule that hides rows is
 *      hiding the one that needed you. `monitoring` is stricter here than for
 *      a hand settle (`canSettle` allows it) because this settle is automatic.
 *   4. NO HUMAN DECISION IS STANDING. A pin says keep it; a settle is already
 *      done and is not ours to restamp; an errand somebody took back off the
 *      shelf is an argument the engine does not get to have twice.
 *   5. THE GRACE HAS PASSED since delivery — its own setting, defaulting to an
 *      hour, and NOT the quiet-session window. The two measure different
 *      things: one guesses from silence, this one counts from a fact.
 *
 * ONLY THE NEWEST ASSIGNMENT IS ASKED ABOUT DELIVERY, and that is what makes
 * the issue's "consumed the wake and immediately sent a new task" case fall out
 * rather than needing a clause of its own: the new task IS the newest
 * assignment, and clause 1 refuses an outstanding one.
 */
import type { SessionActivity, SessionAssignment, SessionSettledBy } from "@telar/engine-client";

const HOUR_MS = 60 * 60 * 1000;

/**
 * The turn shape delivery is read off. Structural, so a caller may pass a
 * `Turn` — and deliberately not `Turn` itself, so the fold's tests are six
 * fields rather than a full queue record.
 */
export type DeliveryTurn = {
  runId: string;
  origin?: string;
  state: string;
  sender?: { sessionId?: string };
  agentIntent?: string;
  agentSourceRunId?: string;
  wakeReason?: { sessionId?: string; runId?: string };
  acceptedAt: number;
  completedAt?: number;
};

export type DelegationSettleInput = {
  now: number;
  /** `null` turns it off: the engine settles nothing on its own. */
  graceHours: number | null;
  delegateSessionId: string;
  /** Everything the delegate holds, in `assignmentsOf` order — NEWEST LAST. */
  assignments: readonly SessionAssignment[];
  /**
   * The turns of the NEWEST assignment's coordinator. Only that one's, because
   * only that one is asked about delivery — see the header. An archived
   * coordinator's turns count exactly as much as a live one's: delivery is
   * something that already happened.
   */
  coordinatorTurns: readonly DeliveryTurn[];
  /** The delegate's own state, as the engine derives it. */
  activity: SessionActivity;
  settledOverride?: "settled" | "active";
  archived: boolean;
  /** `Session.unsettledAssignments` — errands a human took back. */
  unsettledAssignments: readonly string[];
};

export type DelegationSettleResult = {
  /** Write this, and `settledOverride: "settled"` with it. */
  settle?: SessionSettledBy;
  /**
   * WHEN IT WOULD SETTLE, when the grace is the only thing left. What the slow
   * timer exists for, and absent whenever something else is holding the row —
   * so "nothing is due here" and "it is due at 4pm" are different answers
   * rather than one number a caller has to interpret.
   */
  dueAt?: number;
};

/**
 * The assignment delivery is measured on.
 *
 * BY POSITION, NOT BY `receivedAt`. `assignmentsOf` folds in queue order and
 * says so ("newest last"); the timestamp is the recipient turn's and a sort on
 * it would reorder two tasks that landed in the same millisecond.
 */
export function newestAssignment(assignments: readonly SessionAssignment[]): SessionAssignment | undefined {
  return assignments.length === 0 ? undefined : assignments[assignments.length - 1];
}

/**
 * WHEN THE COORDINATOR TOOK DELIVERY of this assignment, or nothing if it has
 * not. Two ways, and they are the two the engine can actually see:
 *
 *   - A `result` REACHED IT. The delegate called `sessions_send` from inside
 *     the run doing the work, so the turn on the coordinator names that run in
 *     `agentSourceRunId` — the same pair `fireSubscriptions` dedupes on.
 *   - A WAKE FOR THAT RUN WAS CONSUMED by a turn that COMPLETED. A wake still
 *     queued is not delivery, and one whose turn failed or was stopped is a
 *     coordinator that did not get to read it.
 *
 * A DETACHED ASSIGNMENT NEEDS NO DELIVERY. "Continue independently" is a human
 * saying the errand is no longer this coordinator's; waiting for a result
 * nobody is going to send would keep the row forever. The grace runs from the
 * detach instead.
 */
export function deliveryOf(
  assignment: SessionAssignment,
  delegateSessionId: string,
  coordinatorTurns: readonly DeliveryTurn[],
): number | undefined {
  if (assignment.outcome === "detached") return assignment.endedAt;
  for (const turn of coordinatorTurns) {
    if (
      turn.origin === "session" &&
      turn.agentIntent === "result" &&
      turn.sender?.sessionId === delegateSessionId &&
      turn.agentSourceRunId === assignment.runId
    ) {
      return turn.acceptedAt;
    }
  }
  for (const turn of coordinatorTurns) {
    if (
      turn.wakeReason?.sessionId === delegateSessionId &&
      turn.wakeReason.runId === assignment.runId &&
      turn.state === "completed" &&
      turn.completedAt !== undefined
    ) {
      return turn.completedAt;
    }
  }
  return undefined;
}

/** Finished, in the sense clause 1 means — a failure is not. */
const finished = (assignment: SessionAssignment): boolean =>
  !assignment.unresolved &&
  (assignment.outcome === "completed" || assignment.outcome === "stopped" || assignment.outcome === "detached");

/** Should this delegate be shelved now, and if not, when might it be? */
export function delegationSettle(input: DelegationSettleInput): DelegationSettleResult {
  if (input.graceHours === null) return {};
  // An archived session is already off every list by a decision that outranks
  // this one, and `updateSession` refuses to write to it at all.
  if (input.archived) return {};

  const newest = newestAssignment(input.assignments);
  // A session nobody handed work to is not a delegate. Report-only peers are
  // out of scope by the issue's own words.
  if (!newest) return {};
  // 1. EVERY assignment, not just the newest: a delegate still running one
  // coordinator's errand is not done because another's finished.
  if (!input.assignments.every(finished)) return {};

  // 4a. An errand a human took back is never re-settled. Checked before
  // delivery so the record stands whatever the facts go on to say.
  if (input.unsettledAssignments.includes(newest.taskRunId)) return {};
  // 4b. A standing human decision in either direction. "settled" is already
  // where this would put it, and restamping it would relabel somebody's own
  // decision as the engine's.
  if (input.settledOverride !== undefined) return {};

  // 2. Delivery.
  const delivered = deliveryOf(newest, input.delegateSessionId, input.coordinatorTurns);
  if (delivered === undefined) return {};

  // 3. Blockers, LAST of the standing conditions and deliberately after
  // delivery: a row held only because it is busy right now is still due, and
  // `dueAt` would be a lie if it were reported for one that will never settle.
  // `monitoring` too: a delegate whose errand is delivered but whose shell or
  // sub-agent is still running has not finished, and a settle nobody asked for
  // must not shelve it. Only a person may, and `canSettle` still lets them.
  if (input.activity === "blocked" || input.activity === "working" || input.activity === "queued" || input.activity === "monitoring") return {};

  // 5. The grace.
  const dueAt = delivered + input.graceHours * HOUR_MS;
  if (input.now < dueAt) return { dueAt };
  return {
    settle: { kind: "delegation", coordinatorSessionId: newest.fromSessionId, runId: newest.taskRunId, at: delivered },
    dueAt,
  };
}
