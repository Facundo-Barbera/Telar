import { isSessionRunLive } from "@/lib/chat-runs";
import { appendFeedEvent, startSessionFeedWindow } from "@/lib/session-log";
import { closeSessionRuntime } from "@/lib/server/session-runtime";
import { armPendingFork, getChat, rollbackChat, settleSpawnStatuses } from "@/lib/store";
import { planRollback } from "@/server/session/rollback";

export const dynamic = "force-dynamic";

// REMOVE THIS EXCHANGE — and, later, any deeper rollback (message-lifecycle
// STEP 4). Addressed by turn index + expectedTurns; SDK identity never
// crosses the wire (the planner reads the anchors server-side).
//
// ORDER OF OPERATIONS, each line load-bearing (mechanics §F3):
//  1. 409 while a turn runs — the client's "Stop and edit" is stop → await →
//     rollback, so the user still experiences one act.
//  2. closeSessionRuntime — closeNow. A warm runtime has the UNTRUNCATED
//     history loaded and would silently ignore a fork target (resume options
//     are only read at create()); and agents spawned by turns that no longer
//     exist must not keep reporting into a history that no longer contains
//     what spawned them. closeNow also nulls the window sink first, so a
//     late settle-append can never land in a transcript being truncated.
//  3. settleSpawnStatuses with no ids — kept turns' ack-only spawn parts get
//     "stopped" instead of shimmering "running" over a killed process.
//  4. rollbackChat under the optimistic expectedTurns check.
//  5. arm the one-shot fork (Claude; Codex routes to thread/rollback in
//     STEP 6 and needs no fork).
//  6. announce: a fresh hidden feed window carrying one `rolled_back` line
//     then `closed` — every stale-cursor subscriber re-bases, truncates its
//     local transcript to `messages`, and the tail ends. No new transport.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  const body = (await req.json().catch(() => ({}))) as {
    toTurn?: unknown;
    expectedTurns?: unknown;
  };
  const toTurn = body.toTurn;
  const expectedTurns = body.expectedTurns;
  if (!Number.isInteger(toTurn) || !Number.isInteger(expectedTurns)) {
    return Response.json({ error: "toTurn and expectedTurns are required." }, { status: 400 });
  }
  const chat = getChat(sessionId);
  if (!chat) return new Response("not found", { status: 404 });
  if (isSessionRunLive(sessionId)) {
    return Response.json(
      { error: "A turn is still running — stop it first." },
      { status: 409 },
    );
  }
  const plan = planRollback(chat, toTurn as number);
  if (plan.kind === "refused") {
    return Response.json({ error: plan.reason }, { status: 400 });
  }
  if (plan.kind === "codex") {
    // STEP 6 wires thread/rollback; until then the honest sentence.
    return Response.json(
      { error: "Codex sessions can't remove exchanges yet." },
      { status: 400 },
    );
  }

  closeSessionRuntime(sessionId);
  settleSpawnStatuses(sessionId);
  const result = rollbackChat(sessionId, {
    toTurn: toTurn as number,
    expectedTurns: expectedTurns as number,
  });
  if (!result.ok) return Response.json({ error: result.reason }, { status: 409 });
  armPendingFork(sessionId, {
    resumeSessionAt: plan.resumeSessionAt,
    ...(plan.resumeDropsTurn ? { resumeDropsTurn: plan.resumeDropsTurn } : {}),
    armedAt: Date.now(),
  });

  startSessionFeedWindow(sessionId, `rollback-${crypto.randomUUID()}`, "", true);
  appendFeedEvent(sessionId, "rolled_back", { turns: toTurn, messages: result.messages });
  appendFeedEvent(sessionId, "closed", {});

  return Response.json({ ok: true, turns: toTurn, messages: result.messages });
}
