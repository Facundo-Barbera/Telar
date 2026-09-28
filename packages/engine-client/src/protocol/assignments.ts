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
  sourceRunId: Id.optional(),
  /** What the sender said it covers. Descriptive; confers nothing. */
  scope: z.string().optional(),
  receivedAt: Timestamp,
  runId: Id,
  /** Absent while outstanding, and absent when `unresolved`. */
  outcome: AssignmentOutcome.optional(),
  endedAt: Timestamp.optional(),
  unresolved: z.literal(true).optional(),
});
export type SessionAssignment = z.infer<typeof SessionAssignment>;

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

export function unresolvedAssignments(turns: readonly AssignmentTurn[]): SessionAssignment[] {
  return assignmentsOf(turns).filter((a) => a.unresolved === true);
}

export function reviewableAssignments(turns: readonly AssignmentTurn[]): SessionAssignment[] {
  return assignmentsOf(turns).filter(
    (assignment) => assignment.outcome !== undefined && assignment.outcome !== "detached",
  );
}
