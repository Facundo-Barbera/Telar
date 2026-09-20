import type { Host } from "./book";
import { HOST_NAME_HEADER } from "./client";
import { HOST_HEADER } from "@/lib/remote/host-token";

/**
 * ONE REQUEST, FORWARDED TO ANOTHER MAC'S COCKPIT — the hop behind
 * `/api/hosts/:id/*`.
 *
 * Method, query, body and the content headers go through untouched; the only
 * thing added is that Mac's bearer. Nothing is parsed on the way: an
 * attachment upload is a raw file body, a diff is JSON, a project icon is a
 * PNG, and the proxy is correct for all of them precisely because it does not
 * know which it is carrying. The answer comes back the same way — status,
 * body, content type — so every existing error path on the client keeps
 * working: a 404 from over there is a 404 here.
 *
 * WHAT IS STRIPPED. The caller's own credentials (`authorization`, `cookie`,
 * and the desktop shell's host header) name a device — or the launcher — of
 * THIS cockpit and would be nonsense, or a leak, over there; `host` and the
 * hop-by-hop headers belong to the connection, not the request. The remote's
 * `set-cookie` is dropped on the way back for the mirror reason: the remote
 * pairs a device, this cockpit does not become one.
 *
 * WHAT IS ADDED, and it is the only thing: `telar-host` / `telar-host-id`,
 * naming the Mac this answer came from (#204). A 404 carried back faithfully is
 * indistinguishable from one this Mac minted — "session does not exist" with
 * nothing saying whose session store was asked — so the identity of the
 * ANSWERING machine rides with the answer. Set from the book AFTER the upstream
 * headers are copied, so a remote that sends a header of this name cannot name
 * itself anything here.
 *
 * Pure over `fetch`, so the route is a one-liner and the rules are a test.
 */

const REQUEST_HEADERS_DROPPED = new Set([HOST_HEADER, "authorization", "cookie", "host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade"]);
const RESPONSE_HEADERS_DROPPED = new Set(["set-cookie", "connection", "content-length", "transfer-encoding", "keep-alive", "content-encoding"]);

const UPSTREAM_TIMEOUT_MS = 60_000;

/**
 * A HUNG MAC MUST NOT COST THE RAIL A MINUTE.
 *
 * A Mac that REFUSES answers instantly and renders as "away"; one that hangs —
 * asleep behind a NAT that swallows packets, a Tailscale route that has gone —
 * accepts the connection and says nothing, and every one of its reads then sat
 * here for the full minute. The rail makes four of those per pass, per host, so
 * a single such Mac held four Next server connections for a minute at a time,
 * forever, and its rows stayed un-dimmed for that whole minute because the pass
 * that would have noticed was inside them.
 *
 * SO THE BOUND IS THE READ'S OWN, not one number for the hop. These four are
 * the rail's polling pass: small JSON, asked every three to ten seconds, and
 * nothing a reader is watching is worth ten seconds of silence — an answer that
 * late is already being asked for again. Everything else keeps the minute,
 * because the same hop also carries an attachment upload, a project icon and a
 * diff of a large tree, and those are slow for honest reasons.
 *
 * A LIST, NOT A RULE, and deliberately: "bound every GET" would be the shorter
 * code and would time out the reads that legitimately take longer. Adding a
 * route here is a decision that the rail waits on it.
 */
const LIST_READ_TIMEOUT_MS = 10_000;
const LIST_READS = new Set(["sessions/live", "health", "inbox", "projects"]);

/**
 * A STREAM HAS NO DEADLINE, and this is the one read here that does not (#531).
 *
 * Every bound above exists because silence means a Mac has hung. On the Agent's
 * SSE feed silence is the NORMAL state: an idle Agent emits nothing for hours,
 * and the engine sends a comment frame every 25 seconds precisely so an open
 * connection is not mistaken for a dead one. A minute's timeout here would
 * sever a healthy stream every minute, on a schedule — the remote Agent screen
 * would reconnect for ever and look, from the reader's side, like a feed that
 * keeps dropping.
 *
 * `Infinity` RATHER THAN A BIGGER NUMBER, because there is no honest number:
 * the connection ends when the client goes away or the engine does, and both of
 * those close the socket. `AbortSignal.timeout` is simply not armed for it.
 */
/** Routes that are STREAMS and must never be given a finite upstream timeout:
 *  silence is their normal state, so a bound would sever a healthy connection
 *  on a schedule. `sessions/stream` joined on #586. */
const STREAMS = new Set(["agent/stream", "sessions/stream"]);

export function upstreamTimeout(request: Pick<Request, "method">, path: readonly string[]): number {
  if (request.method.toUpperCase() !== "GET") return UPSTREAM_TIMEOUT_MS;
  const route = path.join("/");
  if (STREAMS.has(route)) return Number.POSITIVE_INFINITY;
  return LIST_READS.has(route) ? LIST_READ_TIMEOUT_MS : UPSTREAM_TIMEOUT_MS;
}

export function upstreamUrl(host: Pick<Host, "baseUrl">, path: string[], search: string): string {
  return `${host.baseUrl}/api/${path.map(encodeURIComponent).join("/")}${search}`;
}

/** The two headers that say whose answer this is. Written last, over anything
 *  the other end sent under the same names. */
export const HOST_ID_HEADER = "telar-host-id";
function stamp(headers: Headers, host: Pick<Host, "id" | "name">): Headers {
  headers.set(HOST_NAME_HEADER, host.name);
  headers.set(HOST_ID_HEADER, host.id);
  return headers;
}

export async function forward(
  request: Request,
  host: Pick<Host, "id" | "name" | "baseUrl" | "deviceToken">,
  path: string[],
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers();
  request.headers.forEach((value, name) => {
    if (!REQUEST_HEADERS_DROPPED.has(name.toLowerCase())) headers.set(name, value);
  });
  headers.set("authorization", `Bearer ${host.deviceToken}`);

  const method = request.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";
  const timeout = upstreamTimeout(request, path);
  let upstream: Response;
  try {
    upstream = await fetcher(upstreamUrl(host, path, url.search), {
      method,
      headers,
      ...(hasBody ? { body: request.body, duplex: "half" } : {}),
      redirect: "manual",
      // An unbounded route arms no timer at all — see `upstreamTimeout`. The
      // caller's own disconnect is what ends a stream, and that signal rides
      // the request already.
      ...(Number.isFinite(timeout) ? { signal: AbortSignal.timeout(timeout) } : {}),
    } as RequestInit);
  } catch {
    // The one answer this hop mints itself: the same code the local adapter
    // uses when its engine is down, so a remote that is away renders as
    // "unavailable" everywhere the local one would. It names the Mac, because
    // "that Mac" is the one thing the reader of a rail holding three of them
    // cannot work out for themselves.
    return Response.json(
      { error: { code: "engine_unavailable", message: `${host.name} did not answer.` } },
      { status: 503, headers: stamp(new Headers({ "cache-control": "no-store", "content-type": "application/json" }), host) },
    );
  }

  const out = new Headers();
  upstream.headers.forEach((value, name) => {
    if (!RESPONSE_HEADERS_DROPPED.has(name.toLowerCase())) out.set(name, value);
  });
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: stamp(out, host) });
}
