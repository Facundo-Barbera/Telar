import type { SessionActivity, SessionAssignment, SessionSettledBy } from "@telar/engine-client";

const HOUR_MS = 60 * 60 * 1000;

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

type DelegationSettleInput = {
  now: number;
  graceHours: number | null;
  delegateSessionId: string;
  assignments: readonly SessionAssignment[];
  coordinatorTurns: readonly DeliveryTurn[];
  activity: SessionActivity;
  settledOverride?: "settled" | "active";
  archived: boolean;
  unsettledAssignments: readonly string[];
  personTurnAt?: number;
};

type DelegationSettleResult = {
  settle?: SessionSettledBy;
  dueAt?: number;
};

export function newestAssignment(assignments: readonly SessionAssignment[]): SessionAssignment | undefined {
  return assignments.length === 0 ? undefined : assignments[assignments.length - 1];
}

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

const finished = (assignment: SessionAssignment): boolean =>
  !assignment.unresolved &&
  (assignment.outcome === "completed" || assignment.outcome === "stopped" || assignment.outcome === "detached");

export function delegationSettle(input: DelegationSettleInput): DelegationSettleResult {
  if (input.graceHours === null) return {};
  if (input.archived) return {};

  const newest = newestAssignment(input.assignments);
  if (!newest) return {};
  if (!input.assignments.every(finished)) return {};

  if (input.unsettledAssignments.includes(newest.taskRunId)) return {};
  if (input.settledOverride !== undefined) return {};
  if (input.personTurnAt !== undefined && input.personTurnAt > newest.receivedAt) return {};

  const delivered = deliveryOf(newest, input.delegateSessionId, input.coordinatorTurns);
  if (delivered === undefined) return {};

  if (input.activity === "blocked" || input.activity === "working" || input.activity === "queued" || input.activity === "monitoring") return {};

  const dueAt = delivered + input.graceHours * HOUR_MS;
  if (input.now < dueAt) return { dueAt };
  return {
    settle: { kind: "delegation", coordinatorSessionId: newest.fromSessionId, runId: newest.taskRunId, at: delivered },
    dueAt,
  };
}
