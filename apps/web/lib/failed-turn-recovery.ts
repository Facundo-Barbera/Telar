import type { TurnState } from "@telar/engine-client";

/** The slice of a journal turn the recovery affordance reasons about. */
export type RecoverableTurn = {
  runId: string;
  state: TurnState;
  kind?: "message" | "compact";
  origin?: "user" | "provider" | "session";
  failure?: string;
};

/**
 * THE ONE FAILED TURN THAT MAY OFFER A CONTINUATION, or nothing.
 *
 * An ordinary failure (the provider process died, the driver threw) leaves the
 * session idle with everything that streamed still in the transcript. The
 * affordance is offered only where continuing is unambiguous: the failed turn
 * is the LATEST human turn, nothing is running or queued behind it, and no
 * ambiguous turn is waiting on its own — separate — decision. An `ambiguous`
 * turn is never treated as failed here; its recovery is its own flow.
 */
export function recoverableFailedTurn<T extends RecoverableTurn>(turns: readonly T[]): T | undefined {
  if (turns.some((turn) => turn.state === "ambiguous")) return undefined;
  if (turns.some((turn) => turn.state === "queued" || turn.state === "claimed" || turn.state === "running" || turn.state === "steering")) {
    return undefined;
  }
  const latest = [...turns].reverse().find((turn) => turn.kind !== "compact" && turn.origin !== "provider" && turn.origin !== "session");
  return latest?.state === "failed" ? latest : undefined;
}

/**
 * Which open requests a person can still act on: those whose turn is still
 * alive (or ambiguous — its own decision pending). One left open on an ended
 * turn has nothing waiting for the answer, so it must not put the composer in
 * answer mode or block send-now. The engine retires these itself; this keeps
 * a stale snapshot from trapping the box in the meantime.
 */
export function actionableRequests<R extends { runId: string; state: string }>(requests: readonly R[], turns: readonly Pick<RecoverableTurn, "runId" | "state">[]): R[] {
  const ended = new Set(turns.filter((turn) => turn.state === "completed" || turn.state === "failed" || turn.state === "stopped" || turn.state === "discarded").map((turn) => turn.runId));
  return requests.filter((request) => request.state === "open" && !ended.has(request.runId));
}

/**
 * The editable message that continues after a failure. NEVER the original
 * prompt — replaying it would redo work the transcript already holds — and
 * never a replacement for words already in the box: an existing draft is kept
 * and the continuation goes after it.
 */
export function continuationDraft(current: string, turn: Pick<RecoverableTurn, "failure">): string {
  const reason = turn.failure?.trim();
  const continuation = `The previous turn ended early${reason ? ` (${reason})` : ""}. Continue from the work that already exists above; do not redo it.`;
  const existing = current.trimEnd();
  return existing ? `${existing}\n\n${continuation}` : continuation;
}
