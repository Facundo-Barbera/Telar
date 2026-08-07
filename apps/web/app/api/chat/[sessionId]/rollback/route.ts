import { isSessionRunLive } from "@/lib/chat-runs";
import { applyRollback } from "@/server/session/apply-rollback";

export const dynamic = "force-dynamic";

// REMOVE THIS EXCHANGE — and any deeper rollback (message-lifecycle STEP 4).
// Addressed by turn index + expectedTurns; SDK identity never crosses the
// wire (the planner reads the anchors server-side).
//
// ORDER OF OPERATIONS lives in applyRollback (shared with the chat POST's
// truncate-then-send), each line load-bearing — see its header. What stays
// HERE is the one check that is about this route's timing, not the record:
// 409 while a turn runs, because the client's "Stop and edit" is stop →
// await stopped result → rollback, so the user still experiences one act.
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
  if (isSessionRunLive(sessionId)) {
    return Response.json(
      { error: "A turn is still running — stop it first." },
      { status: 409 },
    );
  }
  const result = applyRollback(sessionId, toTurn as number, expectedTurns as number);
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ ok: true, turns: result.turns, messages: result.messages });
}
