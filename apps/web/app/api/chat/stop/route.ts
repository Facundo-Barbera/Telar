import { stopChatRun } from "@/lib/chat-runs";
import { closeSessionRuntime } from "@/lib/server/session-runtime";

export const dynamic = "force-dynamic";

// Explicit Stop for a background chat turn (docs/runtime-architecture.md §A.4).
// The turn is no longer bound to its request, so disconnecting the stream can't
// stop it — this endpoint aborts the run's controller instead. Targeted by the
// turn's client-generated `runId` (always available, even before the session id
// exists) or, as a fallback, the `sessionId`.
export async function POST(req: Request) {
  const { runId, sessionId } = await req.json().catch(() => ({}) as Record<string, unknown>);
  const key = typeof runId === "string" ? runId : typeof sessionId === "string" ? sessionId : null;
  if (!key) {
    return Response.json({ error: "runId or sessionId required" }, { status: 400 });
  }
  // Stop stops the TURN, not the product (feel contract rules 12/14/15).
  // This endpoint used to pauseSessionQueue here, so one Esc-Esc silently
  // disabled sending for the whole session until a human found the Resume
  // button — "stop this turn" must never put the session into a mode. Pending
  // messages stay durable and visible; the CLIENT holds them un-sent behind
  // its own interrupted latch and the next Enter releases them.
  // #28: tagged so a Stop that reaches the registry is attributable to THIS
  // endpoint. A logged Stop with any other `via` — or none — did not come
  // through the user-facing Stop path, which is the thing worth catching.
  const stopped = stopChatRun(key, "api/chat/stop");
  // The persistent session runtime can be live with NO turn attached — a
  // background task holding the process between turns. stopChatRun finds no
  // run then; killing the runtime directly is what makes Stop still mean stop.
  // Both keys tried, same reason stopChatRun accepts both.
  let runtimeClosed = closeSessionRuntime(key);
  if (!runtimeClosed && typeof sessionId === "string" && sessionId) {
    runtimeClosed = closeSessionRuntime(sessionId);
  }
  return Response.json({ ok: stopped || runtimeClosed });
}
