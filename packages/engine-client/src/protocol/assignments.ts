/**
 * What a session is working on behalf of — DERIVED from its task turns, never
 * stored beside them.
 *
 * The turn a task arrived as is already the durable record, carrying
 * engine-stamped `sender`, `agentSourceRunId` and its own state. A second
 * stored "active assignment" would be a parallel truth that drifts on exactly
 * the paths hardest to test — a stop, a crash, a steer.
 *
 * Plural: two coordinators can hand a session work at once. Neither is
 * overwritten and neither waits behind an invented queue.
 *
 * A steered task's words join another run (`steer.intoRunId`); `steered` is
 * terminal for the MESSAGE and says nothing about the work, so the assignment
 * follows the joined run.
 *
 * DERIVE THIS OVER THE FULLEST RECORDS AVAILABLE. Over a paged window the joined
 * run may be absent, and absence is not evidence — such an assignment is
 * `unresolved`, never "outstanding". The engine folds over its whole queue and
 * puts the answer on the snapshot and the live list, so a client reads that
 * rather than refolding a page. Even there `unresolved` remains possible:
 * retention or deletion can remove a carrier, and unknown is the truthful
 * answer for one that is genuinely gone.
 *
 * Nothing here confers authority. A scope naming a path does not authorise
 * writing it, and every existing approval still applies.
 */
import { z } from "zod";
import { Id, Timestamp } from "./common";

/** How an assignment ended, when it has. */
export const AssignmentOutcome = z.enum(["completed", "failed", "stopped", "detached"]);
export type AssignmentOutcome = z.infer<typeof AssignmentOutcome>;

export const SessionAssignment = z.object({
  /** The task turn this assignment IS. Its runId is the assignment's identity. */
  taskRunId: Id,
  /** Who handed it over — engine-stamped, never from a tool argument. */
  fromSessionId: Id,
  /** The SENDER's run that sent it. Different from `taskRunId`, which is the
   *  recipient's. Both, because "who asked" and "what arrived" are two facts. */
  sourceRunId: Id.optional(),
  /** What the sender said it covers. Descriptive; confers nothing. */
  scope: z.string().optional(),
  receivedAt: Timestamp,
  /**
   * The run the work is happening in: `taskRunId` normally, the JOINED run when
   * the task was steered. Always the joined id when one was named, even if that
   * run is outside the window — losing it would rename the work.
   */
  runId: Id,
  /** Absent while outstanding, and absent when `unresolved`. */
  outcome: AssignmentOutcome.optional(),
  endedAt: Timestamp.optional(),
  /**
   * The joined run is not in the records this was folded over, so its state is
   * genuinely unknown. NOT outstanding: a paged-out completed carrier would
   * otherwise look busy forever. Rare on an engine fold — it means retention or
   * deletion removed the carrier — and common on a client fold over a page.
   */
  unresolved: z.literal(true).optional(),
});
export type SessionAssignment = z.infer<typeof SessionAssignment>;

/**
 * The turn shape this fold needs. Structural, so a caller may pass a `Turn`.
 *
 * `acceptedAt` IS THE TURN'S OWN NAME FOR WHEN IT ARRIVED. This type said
 * `createdAt`, which no `Turn` has ever carried, so every caller passing a real
 * turn satisfied the type by accident and every assignment's `receivedAt` was
 * `undefined` at runtime while being declared required (issue #380). A field a
 * `Turn` actually has is the only version of this type that can be wrong in a
 * way a compiler will say out loud.
 */
export type AssignmentTurn = {
  runId: string;
  origin?: string;
  state: string;
  sender?: { sessionId?: string };
  agentIntent?: string;
  agentSourceRunId?: string;
  assignmentScope?: string;
  assignmentDetachedAt?: number;
  steer?: { intoRunId?: string };
  /** When the engine accepted the turn — the moment the work arrived. */
  acceptedAt: number;
  completedAt?: number;
};

const TERMINAL = new Set(["completed", "failed", "stopped", "discarded", "ambiguous"]);

const outcomeOf = (state: string): AssignmentOutcome | undefined =>
  state === "completed" ? "completed" : state === "failed" ? "failed" : TERMINAL.has(state) ? "stopped" : undefined;

/**
 * Every assignment a session holds, outstanding and finished, newest last.
 *
 * ONLY `intent: "task"` COUNTS. A report, a result or a blocker is a peer
 * telling you something, not a peer handing you work — treating one as an
 * assignment is how a coordinator's status update would make a session look
 * like somebody's employee.
 */
export function assignmentsOf(turns: readonly AssignmentTurn[]): SessionAssignment[] {
  const byRun = new Map(turns.map((turn) => [turn.runId, turn]));
  const assignments: SessionAssignment[] = [];
  for (const turn of turns) {
    if (turn.origin !== "session" || turn.agentIntent !== "task") continue;
    const fromSessionId = turn.sender?.sessionId;
    if (!fromSessionId) continue;

    // A steered task's work lives in the run it joined; follow that one.
    const joined = turn.state === "steered" ? turn.steer?.intoRunId : undefined;
    const carrier = joined ? byRun.get(joined) : turn;
    const detached = turn.assignmentDetachedAt !== undefined;

    // A named carrier we cannot see is UNKNOWN. Falling back to the task turn
    // would both rename the run and assert it is still running.
    const unresolved = joined !== undefined && carrier === undefined && !detached;
    const outcome = detached ? "detached" : carrier ? outcomeOf(carrier.state) : undefined;
    const endedAt = detached
      ? turn.assignmentDetachedAt
      : outcome && carrier
        ? (carrier.completedAt ?? carrier.acceptedAt)
        : undefined;

    assignments.push({
      taskRunId: turn.runId,
      fromSessionId,
      ...(turn.agentSourceRunId ? { sourceRunId: turn.agentSourceRunId } : {}),
      ...(turn.assignmentScope ? { scope: turn.assignmentScope } : {}),
      receivedAt: turn.acceptedAt,
      runId: joined ?? turn.runId,
      ...(outcome ? { outcome } : {}),
      ...(endedAt === undefined ? {} : { endedAt }),
      ...(unresolved ? { unresolved: true as const } : {}),
    });
  }
  return assignments;
}

/**
 * Outstanding work — what "Working on behalf of" names. An `unresolved`
 * assignment is excluded: absence of a record is not proof of activity.
 */
export function activeAssignments(turns: readonly AssignmentTurn[]): SessionAssignment[] {
  return assignmentsOf(turns).filter((a) => a.outcome === undefined && !a.unresolved);
}

/** Assignments whose carrier was outside the window. Only a partial fold has any. */
export function unresolvedAssignments(turns: readonly AssignmentTurn[]): SessionAssignment[] {
  return assignmentsOf(turns).filter((a) => a.unresolved === true);
}

/**
 * Finished work a coordinator has not settled yet. Related work keeps offering
 * it: dropping a completed assignment the moment its run ended would hide the
 * result the coordinator delegated for. `detached` is excluded — the human
 * already decided.
 */
export function reviewableAssignments(turns: readonly AssignmentTurn[]): SessionAssignment[] {
  return assignmentsOf(turns).filter(
    (assignment) => assignment.outcome !== undefined && assignment.outcome !== "detached",
  );
}
