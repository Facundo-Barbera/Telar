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
 * An ordinary failure (the provider process died, the driver threw, Telar was
 * quit mid-turn) leaves the session idle with everything that streamed still in
 * the transcript. The affordance is offered where continuing is unambiguous:
 * the failed turn is the LATEST human turn and nothing is running or queued
 * behind it.
 *
 * AN AMBIGUOUS TURN NO LONGER HIDES IT, and that suppression was the last thing
 * standing between a recovered session and an ordinary conversation. The two
 * are genuinely separate decisions — an ambiguous turn's card offers its own
 * three verbs, and a failed turn's continuation is about the failed turn. What
 * an ambiguous turn DOES still do is hold dispatch, engine-side; a person may
 * write, and what they write runs once they have decided. An `ambiguous` turn
 * is never itself treated as failed here.
 */
export function recoverableFailedTurn<T extends RecoverableTurn>(turns: readonly T[]): T | undefined {
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
 *
 * `resumable: false` says the session has no provider cursor, so the next turn
 * COLD-STARTS the provider: Telar still holds the transcript, but the agent
 * itself remembers none of it. "Continue from the work above" would then be an
 * instruction pointing at something only the human can see, so the wording
 * changes to ask for the summary the agent needs first. Happens when the lost
 * turn died before the provider announced itself — measured as `undefined` on a
 * turn that never got past `claimed`.
 */
export function continuationDraft(current: string, turn: Pick<RecoverableTurn, "failure">, resumable = true): string {
  const reason = turn.failure?.trim();
  const continuation = resumable
    ? `The previous turn ended early${reason ? ` (${reason})` : ""}. Continue from the work that already exists above; do not redo it.`
    : `The previous turn ended early${reason ? ` (${reason})` : ""}, and this conversation could not be resumed — you will not remember it. Re-read the working tree before changing anything.`;
  const existing = current.trimEnd();
  return existing ? `${existing}\n\n${continuation}` : continuation;
}
