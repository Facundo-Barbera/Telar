import type { LiveSessionsAnswer, LiveSessionsUnchanged, SessionAssignment } from "@telar/engine-client";
import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";
import { loomOwnedSessionIds } from "@/lib/looms/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The assignment map minus the sessions a loom owns — see the call site. */
function ownedRemoved(
  assignments: Record<string, SessionAssignment[]>,
  owned: ReadonlySet<string>,
): Record<string, SessionAssignment[]> {
  if (owned.size === 0) return assignments;
  return Object.fromEntries(Object.entries(assignments).filter(([sessionId]) => !owned.has(sessionId)));
}

/**
 * The whole inbox in one call: every active session across every project,
 * with the project names to label them. Built for remote clients (the phone)
 * where the sidebar's per-project fan-out costs a round-trip each.
 */
export async function GET(request: Request) {
  try {
    const client = await engineClient();
    /**
     * `?since=<revision>` IS PASSED THROUGH, and an unchanged answer returns
     * here rather than below (#459).
     *
     * This proxy re-composes the engine's answer instead of streaming it, so it
     * has to learn the conditional read too — otherwise a browser's rail would
     * pull the full list on every tick while the phone, which reaches the engine
     * verbatim through the hosts proxy, got the cheap one.
     *
     * AN UNCHANGED ANSWER SKIPS `listProjects()` ENTIRELY, which is why the two
     * reads are no longer concurrent. The registry cannot have moved either —
     * writing it bumps the same revision — so the common tick now costs one
     * cheap read instead of two full ones, and the rare changed tick pays one
     * extra local round trip for it.
     */
    const since = new URL(request.url).searchParams.get("since");
    const live: LiveSessionsAnswer | LiveSessionsUnchanged =
      since === null ? await client.liveSessions() : await client.liveSessionsSince(Number(since));
    if (live.unchanged) return Response.json(live);
    const { sessions, assignments, layout, daemonId, inbox, revision } = live;
    const { projects } = await client.listProjects();
    // DETACHMENT (docs/loom-model-v1.md): same subtraction as the per-project
    // list — loom-owned sessions do not exist on ordinary surfaces, and this
    // route is an ordinary surface.
    const owned = loomOwnedSessionIds();
    return Response.json({
      sessions: sessions.filter((session) => !owned.has(session.id)),
      projects,
      // WHO EACH SESSION IS WORKING FOR, forwarded rather than dropped (#316).
      // The engine folds these over every queue and puts them on this list so
      // Related work costs no per-row history read — but this route used to
      // omit the field, so `result.assignments` was undefined for every LOCAL
      // row while the hosts proxy (which forwards the engine verbatim) carried
      // it. That silently emptied `relatedWork`: no row was ever `active` or
      // `review`, so the elbow tree (#324) drew every delegate as a sibling and
      // the scope hint never appeared. Omitted by an engine that predates it.
      //
      // SUBTRACTED THE SAME WAY THE SESSIONS ARE. An entry is keyed by the
      // session it belongs to, so keeping a loom-owned key would name a
      // detached session on a surface that must not know it exists.
      ...(assignments ? { assignments: ownedRemoved(assignments, owned) } : {}),
      // WHERE THE RAIL PUTS THINGS, forwarded rather than fetched again: this
      // is how a drag on the phone or another window reaches this one, on the
      // poll the rail was making anyway. Omitted by an engine that predates it.
      ...(layout ? { layout } : {}),
      // WHICH ENGINE ANSWERED, AND HOW IT BANDS (#459) — forwarded for the same
      // reason, and this is the half that removes two requests rather than
      // saving bytes: the rail used to issue a `health()` and an `inbox()`
      // concurrently with this one, per host, per tick. Omitted by an engine
      // that predates them, which a rail reads as "no answer" and not as one.
      ...(daemonId ? { daemonId } : {}),
      ...(inbox ? { inbox } : {}),
      // WHAT TO ASK WITH NEXT TIME. Absent from an engine too old to count, and
      // a rail that gets none simply keeps making full reads.
      ...(revision === undefined ? {} : { revision }),
    });
  } catch (error) {
    return engineErrorResponse(error);
  }
}
