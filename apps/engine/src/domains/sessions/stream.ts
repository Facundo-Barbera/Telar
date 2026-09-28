import type http from "node:http";
import type { Route } from "../../platform/http/route";
import type { EngineStore } from "../../state";

/** A stream the engine must be able to end on shutdown; `end` also closes the response. */
export type OpenStream = (() => void) & { end?: () => void };

/**
 * Holds an SSE response open: headers flushed with `: open` (writeHead alone doesn't send them),
 * a 25 s `: beat` so proxies keep it, and registration in `openStreams` so `close()` can end it.
 */
export function holdEventStream(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  openStreams: Set<OpenStream>,
  subscribe: (send: (data: unknown) => void) => () => void,
): void {
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
  response.write(": open\n\n");
  const stop = subscribe((data) => {
    try {
      response.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      /* the socket has gone; the close handler unsubscribes */
    }
  });
  const beat = setInterval(() => {
    try {
      response.write(": beat\n\n");
    } catch {
      /* the close handler tidies up */
    }
  }, 25_000);
  beat.unref();
  const finish: OpenStream = () => {
    clearInterval(beat);
    stop();
    openStreams.delete(finish);
  };
  openStreams.add(finish);
  request.on("close", finish);
  response.on("close", finish);
  finish.end = () => {
    finish();
    try {
      response.end();
    } catch {
      /* already gone */
    }
  };
}

/**
 * Every session's events on one connection, live only: event ids are per session, so there is no
 * global cursor to replay from. A frame names a fact a reader re-derives from `/events`; it is never the record.
 */
export function sessionsStreamRoute(store: EngineStore, openStreams: Set<OpenStream>): Route {
  return {
    method: "GET",
    path: "/v2/sessions/stream",
    auth: "engine",
    handle({ request, response }) {
      holdEventStream(request, response, openStreams, (send) =>
        store.watch((event: { sessionId: string; id: number; type: string }) => send({ sessionId: event.sessionId, id: event.id, type: event.type })),
      );
      return undefined;
    },
  };
}
