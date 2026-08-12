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
// THE READ IS WRAPPED, for the same reason the chat route's ack is (review B1).
// `pendingUltraWakes` is not throw-free: it reaches `listUltraRuns`, whose `try`
// guards only the `readdirSync`, and then `getUltraManifest`, whose self-heal
// `saveManifest` is an unwrapped write. One malformed or unhealable manifest
// ANYWHERE under `TELAR_HOME/ultra/` therefore throws for every session,
// including sessions that have never touched Ultra — this scan is not
// session-scoped. Unguarded, that is a 500 on a 4-second poll, for as long as the
// bad manifest is on disk. The hook tolerates a failed poll by design
// (`if (!r.ok) return;`), so the visible cost was "the wake never arrives" plus a
// server-log 500 every tick; degrading to the empty mailbox says the same thing
// without either. The wake is not lost — pending is a projection over the
// manifests, so it is re-reported the moment the root is readable again, and the
// next chat turn's appendix carries it regardless of this route.
export async function GET(req: Request) {
  const sessionId = new URL(req.url).searchParams.get("sessionId")?.trim() ?? "";
  // No session, no wake, and no directory scan — `pendingUltraWakes` short-
  // circuits on this too, but answering here keeps the poll free for the
  // brand-new-session case the hook hits on every mount.
  if (!sessionId) return Response.json({ pending: [], live: 0 });
  try {
    return Response.json({
      pending: pendingUltraWakes(sessionId),
      live: liveUltraRunCount(sessionId),
    });
  } catch {
    return Response.json({ pending: [], live: 0 });
  }
}
