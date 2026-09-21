import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * THE RUN FEED, CARRIED THROUGH (#890) — and it is what two poll loops became.
 *
 * A STATIC SEGMENT IN FRONT OF THE `[...tail]` CATCH-ALL NEXT DOOR, and that is
 * load-bearing rather than incidental: every other run tail is a request that
 * returns a VALUE, forwarded by `lib/run/route-map.ts` through a typed verb.
 * This one holds a socket open for the life of the panel, so it cannot go
 * through that table at all — Next resolves the more specific segment first,
 * which is exactly the split we want.
 *
 * THE SAME PIPE AS `/api/sessions/stream`: `upstream.body` is handed to the
 * `Response` untouched, so nothing here buffers, parses or re-frames a frame.
 * The three headers, the missing timeout and the forwarded abort signal are all
 * that route's reasons restated — read them there; a hop that dropped one would
 * produce a feed that works locally and stalls behind a reverse proxy.
 *
 * NO `after`. A run's status is not a journal a cursor can page: the frame IS
 * the state, whole, so a reader that missed one is corrected by the next.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ sessionId: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const { sessionId } = await context.params;
    const stream = (await engineClient()).runStream(sessionId);
    const upstream = await fetch(stream.url, {
      headers: stream.headers,
      // THE CLIENT'S OWN DISCONNECT IS THE END OF THIS. A closed panel aborts
      // the request, and forwarding the signal is what unsubscribes the
      // engine-side watcher rather than leaving it writing into a dead socket.
      signal: request.signal,
    });
    if (!upstream.ok || !upstream.body) {
      return Response.json(
        { error: { code: "engine_unavailable", message: "The engine did not open the run feed." } },
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
