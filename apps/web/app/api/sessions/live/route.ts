import type { LiveSessionsAnswer, LiveSessionsUnchanged } from "@telar/engine-client";
import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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
    /**
     * `?all=1` IS PASSED THROUGH TOO (#457) — the shelf's ask.
     *
     * The engine answers only the unsettled rows by default; `all=1` is the
     * whole list, and it is deliberately NOT conditional (see the engine's
     * route), so a cursor sent beside it is ignored on both sides rather than
     * answering the wide ask with a narrow "unchanged".
     */
    const query = new URL(request.url).searchParams;
    const all = query.get("all") === "1";
    const since = query.get("since");
    /**
     * `If-None-Match` IS FORWARDED, AND A 304 IS PASSED ON — issue #457.
     *
     * The engine's tag is the revision and the mode, and everything this route
     * ADDS to the engine's answer moves with that same revision: writing the
     * project registry bumps it, which is the assumption `?since=` has always
     * made here (it returns `unchanged` without re-reading `listProjects()` for
     * exactly that reason). So the engine's tag describes this composed body
     * too, and forwarding it is sound under the premise the route already runs
     * on rather than a new one.
     *
     * AND IT IS WHAT MAKES THE WIDE READ CHEAP. `?since=` refuses to be
     * conditional against `?all=1` — the revision does not move when a reader
     * opens a shelf, so a cursor would answer the wide ask with "unchanged" —
     * but the mode is inside the ETag, so this one is safe for both.
     */
    const conditional = request.headers.get("if-none-match") ?? undefined;
    /**
     * THE CURSOR STILL ANSWERS FOR A CALLER THAT SENT ONE AND NO TAG. `?since=`
     * is the older spelling and nothing is taken away from it; a caller that
     * sends a tag gets the header path, which is cheaper (no body at all) and
     * is the only one of the two that is safe against `?all=1`.
     */
    if (conditional === undefined && !all && since !== null) {
      const live: LiveSessionsAnswer | LiveSessionsUnchanged = await client.liveSessionsSince(Number(since));
      if (live.unchanged) return Response.json(live);
      return compose(live);
    }
    /**
     * EVERY OTHER READ GOES THROUGH THE TAG, INCLUDING THE UNCONDITIONAL FIRST
     * ONE. Without that the answer would carry no `ETag`, the caller would have
     * nothing to hand back, and the conditional path would never be entered at
     * all — the cheap tick has to be reachable from a cold start.
     */
    const answer = await client.liveSessionsMatching({
      ...(conditional === undefined ? {} : { etag: conditional }),
      ...(all ? { all: true } : {}),
    });
    if (answer.notModified) {
      return new Response(null, { status: 304, headers: { etag: answer.etag, "cache-control": "no-store" } });
    }
    return compose(answer, answer.etag);
  } catch (error) {
    return engineErrorResponse(error);
  }
}

/** The engine's answer plus the project registry — named so the conditional
 *  path and the cursor path cannot compose it differently. `etag` rides back
 *  out when the engine minted one. */
async function compose(live: LiveSessionsAnswer, etag?: string): Promise<Response> {
  try {
    const client = await engineClient();
    const { sessions, assignments, layout, daemonId, inbox, revision, settledCount, terminals } = live;
    const { projects } = await client.listProjects();
    return Response.json({
      sessions,
      projects,
      // WHO EACH SESSION IS WORKING FOR, forwarded rather than dropped (#316).
      // The engine folds these over every queue and puts them on this list so
      // Related work costs no per-row history read — but this route used to
      // omit the field, so `result.assignments` was undefined for every LOCAL
      // row while the hosts proxy (which forwards the engine verbatim) carried
      // it. That silently emptied `relatedWork`: no row was ever `active` or
      // `review`, so the elbow tree (#324) drew every delegate as a sibling and
      // the scope hint never appeared. Omitted by an engine that predates it.
      ...(assignments ? { assignments } : {}),
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
      // HOW BIG THE SHELF THIS ANSWER LEFT OUT IS (#457) — one integer, and the
      // only thing that tells a rail the list it just received is partial.
      // Absent from an engine that predates the filter, which reads as "you have
      // everything" rather than as an empty shelf.
      ...(settledCount === undefined ? {} : { settledCount }),
      // WHAT EACH ROW STILL HAS OPEN (#883) — Settle's count and a settled
      // row's mark, on the read the rail makes anyway. Same revision as the rows.
      ...(terminals ? { terminals } : {}),
    }, {
      // THE ENGINE'S TAG, HANDED STRAIGHT BACK (#457) — so the caller's next
      // `If-None-Match` is a tag this engine will recognise. Absent from an
      // engine that predates it, and a caller with no tag simply goes on
      // reading in full.
      ...(etag === undefined ? {} : { headers: { etag, "cache-control": "no-store" } }),
    });
  } catch (error) {
    return engineErrorResponse(error);
  }
}
