import type { TurnState } from "@telar/engine-client";

export type RecoverableTurn = {
  runId: string;
  state: TurnState;
  kind?: "message" | "compact";
  origin?: "user" | "provider" | "session";
  failure?: string;
};

/**
 * The latest human turn if it failed and nothing is running or queued behind it.
 * An `ambiguous` turn is never treated as failed here.
 */
export function recoverableFailedTurn<T extends RecoverableTurn>(turns: readonly T[]): T | undefined {
  if (turns.some((turn) => turn.state === "queued" || turn.state === "claimed" || turn.state === "running" || turn.state === "steering")) {
    return undefined;
  }
  const latest = [...turns].reverse().find((turn) => turn.kind !== "compact" && turn.origin !== "provider" && turn.origin !== "session");
  return latest?.state === "failed" ? latest : undefined;
}

/**
 * Open requests whose turn has not ended. The engine retires the rest itself;
 * this keeps a stale snapshot from trapping the composer in answer mode.
 */
export function actionableRequests<R extends { runId: string; state: string }>(requests: readonly R[], turns: readonly Pick<RecoverableTurn, "runId" | "state">[]): R[] {
  const ended = new Set(turns.filter((turn) => turn.state === "completed" || turn.state === "failed" || turn.state === "stopped" || turn.state === "discarded").map((turn) => turn.runId));
  return requests.filter((request) => request.state === "open" && !ended.has(request.runId));
}

/**
 * Appends a continuation note after any existing draft; never replays the original prompt.
 * Pass `resumable: false` when the session has no provider cursor, so the agent
 * is told it will not remember the conversation.
 */
export function continuationDraft(current: string, turn: Pick<RecoverableTurn, "failure">, resumable = true): string {
  const reason = turn.failure?.trim();
  const continuation = resumable
    ? `The previous turn ended early${reason ? ` (${reason})` : ""}. Continue from the work that already exists above; do not redo it.`
    : `The previous turn ended early${reason ? ` (${reason})` : ""}, and this conversation could not be resumed — you will not remember it. Re-read the working tree before changing anything.`;
  const existing = current.trimEnd();
  return existing ? `${existing}\n\n${continuation}` : continuation;
}
