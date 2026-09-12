import type { Host } from "./book";
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

export function upstreamTimeout(request: Pick<Request, "method">, path: readonly string[]): number {
  if (request.method.toUpperCase() !== "GET") return UPSTREAM_TIMEOUT_MS;
  return LIST_READS.has(path.join("/")) ? LIST_READ_TIMEOUT_MS : UPSTREAM_TIMEOUT_MS;
}

export function upstreamUrl(host: Pick<Host, "baseUrl">, path: string[], search: string): string {
  return `${host.baseUrl}/api/${path.map(encodeURIComponent).join("/")}${search}`;
}

export async function forward(
  request: Request,
  host: Pick<Host, "baseUrl" | "deviceToken">,
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
  let upstream: Response;
  try {
    upstream = await fetcher(upstreamUrl(host, path, url.search), {
      method,
      headers,
      ...(hasBody ? { body: request.body, duplex: "half" } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(upstreamTimeout(request, path)),
    } as RequestInit);
  } catch {
    // The one answer this hop mints itself: the same code the local adapter
    // uses when its engine is down, so a remote that is away renders as
    // "unavailable" everywhere the local one would.
    return Response.json(
      { error: { code: "engine_unavailable", message: "That Mac did not answer." } },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  const out = new Headers();
  upstream.headers.forEach((value, name) => {
    if (!RESPONSE_HEADERS_DROPPED.has(name.toLowerCase())) out.set(name, value);
  });
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
}
