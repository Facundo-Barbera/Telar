import { liveUltraRunCount, pendingUltraWakes } from "@telar/core";

export const dynamic = "force-dynamic";

// Story 4.1 / AC1 — this session's pending completion wakes, plus how many of
// its runs are still live.
//
// The client hook (`@/lib/use-ultra-wake`) polls this and hands session-view a
// trigger; the OUTCOME never travels this way to the model. The route's answer
// drives WHETHER a turn fires, and the turn's system-prompt appendix — composed
// server-side in @/lib/session-prompts from the same durable mailbox — is what
// carries WHAT the outcome was. That split is deliberate: the client authors the
// trigger and never the facts.
//
// `live` is what makes the poll self-limiting (NFR-X-15): the hook polls while
// something is running or something is pending, and stops otherwise, so an idle
// session with no runs makes no traffic at all. It is NOT an EventSource —
// `/api/ultra/[id]/events` exists and is the per-run stream story 4.2's anchor
// uses; a wake needs one small session-scoped question answered, not a stream
// per run.
//
// A STATIC SEGMENT SIBLING TO A DYNAMIC ONE. This sits beside the existing
// `app/api/ultra/[id]/`, and the App Router matches the static segment first.
// The repo already relies on exactly that shape: `app/api/chat/stop/` and
// `app/api/chat/permission/` sit beside `app/api/chat/[sessionId]/` and have
// since before this story.
export async function GET(req: Request) {
  const sessionId = new URL(req.url).searchParams.get("sessionId")?.trim() ?? "";
  // No session, no wake, and no directory scan — `pendingUltraWakes` short-
  // circuits on this too, but answering here keeps the poll free for the
  // brand-new-session case the hook hits on every mount.
  if (!sessionId) return Response.json({ pending: [], live: 0 });
  return Response.json({
    pending: pendingUltraWakes(sessionId),
    live: liveUltraRunCount(sessionId),
  });
}
