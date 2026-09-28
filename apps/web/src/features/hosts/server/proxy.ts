import type { Host } from "./store";
import { HOST_NAME_HEADER } from "@/platform/engine/host-client";
import { HOST_HEADER } from "@/features/remote/server";

const REQUEST_HEADERS_DROPPED = new Set([HOST_HEADER, "authorization", "cookie", "host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade"]);
const RESPONSE_HEADERS_DROPPED = new Set(["set-cookie", "connection", "content-length", "transfer-encoding", "keep-alive", "content-encoding"]);

const UPSTREAM_TIMEOUT_MS = 60_000;

const LIST_READ_TIMEOUT_MS = 10_000;
const LIST_READS = new Set(["sessions/live", "health", "inbox", "projects"]);

function isRunStream(path: readonly string[]): boolean {
  return path.length === 4 && path[0] === "sessions" && path[2] === "run" && path[3] === "stream";
}

export function upstreamTimeout(request: Pick<Request, "method">, path: readonly string[]): number {
  if (request.method.toUpperCase() !== "GET") return UPSTREAM_TIMEOUT_MS;
  const route = path.join("/");
  if (isRunStream(path)) return Number.POSITIVE_INFINITY;
  return LIST_READS.has(route) ? LIST_READ_TIMEOUT_MS : UPSTREAM_TIMEOUT_MS;
}

export function upstreamUrl(host: Pick<Host, "baseUrl">, path: string[], search: string): string {
  return `${host.baseUrl}/api/${path.map(encodeURIComponent).join("/")}${search}`;
}

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
      ...(Number.isFinite(timeout) ? { signal: AbortSignal.timeout(timeout) } : {}),
    } as RequestInit);
  } catch {
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
