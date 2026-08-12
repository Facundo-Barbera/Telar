import { accountEnv, getAccount } from "@telar/core";
import { runCodexRollback } from "@/lib/codex-app-server";
import { appendFeedEvent, startSessionFeedWindow } from "@/lib/session-log";
import { closeSessionRuntime } from "@/lib/server/session-runtime";
import {
  armPendingFork,
  getChat,
  markLastTurnInterrupted,
  rollbackChat,
  settleSpawnStatuses,
} from "@/lib/store";
import { planRollback } from "@/server/session/rollback";

// THE APPLY STEP, shared verbatim by the standalone rollback route and the
// chat POST's `rollbackToTurn` (STEP 5: truncate-then-send is ONE request, so
// the runtime is recreated exactly once). planRollback stays pure next door;
// this owns the I/O sequence whose ORDER is the correctness argument — see
// the rollback route's header for why each line sits where it does.
export type ApplyRollbackResult =
  | { ok: true; turns: number; messages: number }
  | { ok: false; status: number; error: string };

export async function applyRollback(
  sessionId: string,
  toTurn: number,
  expectedTurns: number,
): Promise<ApplyRollbackResult> {
  const chat = getChat(sessionId);
  if (!chat) return { ok: false, status: 404, error: "not found" };
  const plan = planRollback(chat, toTurn);
  if (plan.kind === "refused") return { ok: false, status: 400, error: plan.reason };

  closeSessionRuntime(sessionId);
  settleSpawnStatuses(sessionId);
  const result = rollbackChat(sessionId, { toTurn, expectedTurns });
  if (!result.ok) return { ok: false, status: 409, error: result.reason };

  if (plan.kind === "claude") {
    armPendingFork(sessionId, {
      resumeSessionAt: plan.resumeSessionAt,
      ...(plan.resumeDropsTurn ? { resumeDropsTurn: plan.resumeDropsTurn } : {}),
      armedAt: Date.now(),
    });
  } else {
    // STEP 6: Codex truncates its OWN ledger — thread/rollback, the native
    // RPC, no fork to arm (the anchor index was the whole address). The
    // store truncated first, matching the Claude flow's shape; a provider
    // that cannot follow (older app-server, no account, transport) gets the
    // same honest floor as the Claude ladder's: the transcript stays
    // truncated and one amber line says what the screen cannot promise.
    try {
      // The session's OWN persisted account — existing sessions stay locked
      // to it (the same rule every turn follows).
      const account = getAccount(chat.account);
      if (!account) throw new Error("account gone");
      await runCodexRollback({
        threadId: sessionId,
        numTurns: expectedTurns - toTurn,
        env: accountEnv(account),
      });
    } catch {
      markLastTurnInterrupted(
        sessionId,
        "The agent may still remember the messages you removed.",
      );
    }
  }

  startSessionFeedWindow(sessionId, `rollback-${crypto.randomUUID()}`, "", true);
  appendFeedEvent(sessionId, "rolled_back", { turns: toTurn, messages: result.messages });
  appendFeedEvent(sessionId, "closed", {});
  return { ok: true, turns: toTurn, messages: result.messages };
}
