import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * EVERY SESSION'S EVENTS, CARRIED THROUGH (#586).
 *
 * THE SECOND STREAMING ROUTE IN THIS COCKPIT, and it is the same PIPE the
 * Agent's is: `upstream.body` is handed to the `Response` untouched, so nothing
 * here buffers, parses or re-frames a frame. The whole value of the route is
 * that a request parked for approval reaches a reader at the moment the engine
 * writes it, and a route that awaited `.text()` would deliver a day's events at
 * once when the daemon finally stopped.
 *
 * NO `after`, UNLIKE THE AGENT'S — and this is the one place the two feeds
 * differ. An event id in this engine is per session (`PRIMARY KEY(session_id,
 * id)`), so there is no machine-wide cursor to replay from: the feed is
 * live-only, and a reader closes a gap with the reconcile poll it already has
 * rather than with a replay. Accepting a parameter that silently meant nothing
 * would be worse than not offering one.
 *
 * ── THE THREE HEADERS, RE-STATED RATHER THAN COPIED ─────────────────────────
 * `text/event-stream` is what makes `EventSource` accept it at all. `no-cache,
 * no-transform` stops a proxy re-encoding the body — a gzip layer that buffers
 * to fill a block turns a live feed into a batch. `x-accel-buffering: no` is
 * the same instruction again for the one proxy that ignores the other two.
 * They are this route's own answer, and a hop that dropped one would produce a
 * stream that works locally and stalls behind a reverse proxy.
 *
 * ── NO TIMEOUT, DELIBERATELY ────────────────────────────────────────────────
 * Silence is this connection's normal state, so an `AbortSignal.timeout` would
 * sever a healthy one on a schedule. The engine sends a comment frame every 25
 * seconds so idle is not mistaken for dead; `lib/hosts/proxy.ts` carries the
 * same exemption for a remote Mac's copy of this route.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const stream = (await engineClient()).sessionsStream();
    const upstream = await fetch(stream.url, {
      headers: stream.headers,
      // THE CLIENT'S OWN DISCONNECT IS THE END OF THIS. A closed tab aborts the
      // request, and forwarding the signal is what unsubscribes the engine-side
      // watcher rather than leaving it writing into a socket nobody reads.
      signal: request.signal,
    });
    if (!upstream.ok || !upstream.body) {
      return Response.json(
        { error: { code: "engine_unavailable", message: "The engine did not open the session feed." } },
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
