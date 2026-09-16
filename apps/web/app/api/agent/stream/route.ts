import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * THE AGENT'S LIVE FEED, CARRIED THROUGH (#531).
 *
 * THE ONLY STREAMING ROUTE IN THIS COCKPIT, and it is a PIPE rather than a
 * reader: `upstream.body` is handed to the `Response` untouched, so nothing
 * here buffers, parses or re-frames a single event. Every other route under
 * `/api` re-composes the engine's answer — this one must not, because the whole
 * value of the route is that a token appears on the screen at the moment the
 * engine emits it, and a route that awaited `.text()` would deliver the entire
 * turn at once when it finished.
 *
 * `after` IS A TRANSCRIPT CURSOR and the engine replays from it INSIDE the same
 * response before the live feed starts. That is what closes the gap a
 * page-then-subscribe would leave, and it is why a reconnect is cheap: the
 * client passes the last row id it saw and loses nothing.
 *
 * ── THE THREE HEADERS, AND WHY EACH ONE IS SPELLED HERE ─────────────────────
 * `text/event-stream` is what makes `EventSource` accept it at all. `no-cache,
 * no-transform` stops a proxy re-encoding the body — a gzip layer that buffers
 * to fill a block turns a live feed into a batch. `x-accel-buffering: no` is
 * the same instruction again for the one proxy that ignores the other two.
 *
 * They are re-stated rather than copied off the upstream response because this
 * route's own answer is what the browser sees, and a hop that dropped one of
 * them would produce a stream that works locally and stalls behind a reverse
 * proxy — the failure that is hardest to reproduce and easiest to prevent.
 *
 * ── NO TIMEOUT, DELIBERATELY ────────────────────────────────────────────────
 * Every other engine read here is bounded, because a Mac that hangs must not
 * cost the rail a minute. A stream is the opposite case: silence is its normal
 * state, and an `AbortSignal.timeout` would sever a healthy connection on a
 * schedule. The engine sends a comment frame every 25 seconds so an idle
 * connection is not mistaken for a dead one; a genuinely dead one ends, and the
 * client reconnects with its cursor.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const after = Number(new URL(request.url).searchParams.get("after") ?? 0);
    const stream = (await engineClient()).agentStream(Number.isFinite(after) && after > 0 ? after : 0);
    const upstream = await fetch(stream.url, {
      headers: stream.headers,
      // THE CLIENT'S OWN DISCONNECT IS THE END OF THIS. A closed tab aborts the
      // request, and forwarding the signal is what unsubscribes the engine-side
      // watcher rather than leaving it writing into a socket nobody reads.
      signal: request.signal,
    });
    if (!upstream.ok || !upstream.body) {
      return Response.json(
        { error: { code: "engine_unavailable", message: "The engine did not open the Agent's stream." } },
        { status: upstream.status === 200 ? 503 : upstream.status },
      );
    }
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  } catch (error) {
    return engineErrorResponse(error);
  }
}
