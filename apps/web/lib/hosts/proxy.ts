import type { Host } from "./book";

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
 * WHAT IS STRIPPED. The caller's own credentials (`authorization`, `cookie`)
 * name a device of THIS cockpit and would be nonsense — or a leak — over
 * there; `host` and the hop-by-hop headers belong to the connection, not the
 * request. The remote's `set-cookie` is dropped on the way back for the
 * mirror reason: the remote pairs a device, this cockpit does not become one.
 *
 * Pure over `fetch`, so the route is a one-liner and the rules are a test.
 */

const REQUEST_HEADERS_DROPPED = new Set(["authorization", "cookie", "host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade"]);
const RESPONSE_HEADERS_DROPPED = new Set(["set-cookie", "connection", "content-length", "transfer-encoding", "keep-alive", "content-encoding"]);

const UPSTREAM_TIMEOUT_MS = 60_000;

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
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
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
