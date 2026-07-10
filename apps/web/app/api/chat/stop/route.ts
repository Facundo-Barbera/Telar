import { stopChatRun } from "@/lib/chat-runs";

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
  const stopped = stopChatRun(key);
  return Response.json({ ok: stopped });
}
