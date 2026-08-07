import { appendFeedEvent, startSessionFeedWindow } from "@/lib/session-log";
import { closeSessionRuntime } from "@/lib/server/session-runtime";
import { armPendingFork, getChat, rollbackChat, settleSpawnStatuses } from "@/lib/store";
import { planRollback } from "@/server/session/rollback";

// THE APPLY STEP, shared verbatim by the standalone rollback route and the
// chat POST's `rollbackToTurn` (STEP 5: truncate-then-send is ONE request, so
// the runtime is recreated exactly once). planRollback stays pure next door;
// this owns the I/O sequence whose ORDER is the correctness argument — see
// the rollback route's header for why each line sits where it does.
export type ApplyRollbackResult =
  | { ok: true; turns: number; messages: number }
  | { ok: false; status: number; error: string };

export function applyRollback(
  sessionId: string,
  toTurn: number,
  expectedTurns: number,
): ApplyRollbackResult {
  const chat = getChat(sessionId);
  if (!chat) return { ok: false, status: 404, error: "not found" };
  const plan = planRollback(chat, toTurn);
  if (plan.kind === "refused") return { ok: false, status: 400, error: plan.reason };
  if (plan.kind === "codex") {
    // STEP 6 wires thread/rollback; until then the honest sentence.
    return { ok: false, status: 400, error: "Codex sessions can't remove exchanges yet." };
  }

  closeSessionRuntime(sessionId);
  settleSpawnStatuses(sessionId);
  const result = rollbackChat(sessionId, { toTurn, expectedTurns });
  if (!result.ok) return { ok: false, status: 409, error: result.reason };
  armPendingFork(sessionId, {
    resumeSessionAt: plan.resumeSessionAt,
    ...(plan.resumeDropsTurn ? { resumeDropsTurn: plan.resumeDropsTurn } : {}),
    armedAt: Date.now(),
  });

  startSessionFeedWindow(sessionId, `rollback-${crypto.randomUUID()}`, "", true);
  appendFeedEvent(sessionId, "rolled_back", { turns: toTurn, messages: result.messages });
  appendFeedEvent(sessionId, "closed", {});
  return { ok: true, turns: toTurn, messages: result.messages };
}
