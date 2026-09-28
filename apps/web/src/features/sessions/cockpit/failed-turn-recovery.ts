import type { TurnState } from "@telar/engine-client";

export type RecoverableTurn = {
  runId: string;
  state: TurnState;
  kind?: "message" | "compact";
  origin?: "user" | "provider" | "session";
  failure?: string;
};

export function recoverableFailedTurn<T extends RecoverableTurn>(turns: readonly T[]): T | undefined {
  if (turns.some((turn) => turn.state === "queued" || turn.state === "claimed" || turn.state === "running" || turn.state === "steering")) {
    return undefined;
  }
  const latest = [...turns].reverse().find((turn) => turn.kind !== "compact" && turn.origin !== "provider" && turn.origin !== "session");
  return latest?.state === "failed" ? latest : undefined;
}

export function actionableRequests<R extends { runId: string; state: string }>(requests: readonly R[], turns: readonly Pick<RecoverableTurn, "runId" | "state">[]): R[] {
  const ended = new Set(turns.filter((turn) => turn.state === "completed" || turn.state === "failed" || turn.state === "stopped" || turn.state === "discarded").map((turn) => turn.runId));
  return requests.filter((request) => request.state === "open" && !ended.has(request.runId));
}

export function continuationDraft(current: string, turn: Pick<RecoverableTurn, "failure">, resumable = true): string {
  const reason = turn.failure?.trim();
  const continuation = resumable
    ? `The previous turn ended early${reason ? ` (${reason})` : ""}. Continue from the work that already exists above; do not redo it.`
    : `The previous turn ended early${reason ? ` (${reason})` : ""}, and this conversation could not be resumed — you will not remember it. Re-read the working tree before changing anything.`;
  const existing = current.trimEnd();
  return existing ? `${existing}\n\n${continuation}` : continuation;
}
