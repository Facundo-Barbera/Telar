import type http from "node:http";
import { Readable } from "node:stream";
import { fail, type Route } from "../../platform/http/route";
import type { Host } from "./book";
import type { HostsStore } from "./store";

export const HOST_NAME_HEADER = "telar-host";
export const HOST_ID_HEADER = "telar-host-id";
const REQUEST_HEADERS_DROPPED = new Set(["x-telar-host", "authorization", "cookie", "host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade"]);
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
  closed?: AbortSignal,
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
  const signals = [...(closed ? [closed] : []), ...(Number.isFinite(timeout) ? [AbortSignal.timeout(timeout)] : [])];
  let upstream: Response;
  try {
    upstream = await fetcher(upstreamUrl(host, path, url.search), {
      method,
      headers,
      ...(hasBody ? { body: request.body, duplex: "half" } : {}),
      redirect: "manual",
      ...(signals.length ? { signal: AbortSignal.any(signals) } : {}),
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

function webRequest(request: http.IncomingMessage): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  const method = request.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(`http://engine${request.url ?? "/"}`, {
    method,
    headers,
    ...(hasBody ? { body: Readable.toWeb(request) as ReadableStream, duplex: "half" } : {}),
  } as RequestInit);
}

async function send(answer: Response, response: http.ServerResponse): Promise<void> {
  response.writeHead(answer.status, Object.fromEntries(answer.headers));
  if (!answer.body) return void response.end();
  const reader = answer.body.getReader();
  response.on("close", () => void reader.cancel().catch(() => {}));
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      response.write(value);
    }
  } catch {}
  response.end();
}

const FORWARD_PATH = /^\/v2\/hosts\/([^/]+)\/api\/(.+)$/;

export function forwardRoute(store: HostsStore, fetcher: typeof fetch = fetch): Route {
  return {
    method: "*",
    path: FORWARD_PATH,
    auth: "engine",
    body: "raw",
    async handle({ params: [id], request, response }) {
      const host = store.find(id!);
      if (!host) return fail(404, "not_found", "No such host.");
      const rawPath = new URL(request.url ?? "/", "http://engine").pathname.match(FORWARD_PATH)![2]!;
      const closed = new AbortController();
      response.on("close", () => closed.abort());
      await send(await forward(webRequest(request), host, rawPath.split("/").map(decodeURIComponent), fetcher, closed.signal), response);
      return undefined;
    },
  };
}
