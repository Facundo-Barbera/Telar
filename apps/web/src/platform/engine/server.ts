import path from "node:path";
import { canonicalPath, isLegacyTelarHome } from "@/platform/telar-home";
import {
  EngineClientError,
  type EngineClient,
  type EngineErrorCode,
} from "@telar/engine-client";
import { connectEngine } from "@telar/engine-client/node";

/** Telar routes are available only through the launcher, which rejects legacy homes before Next boots. */
export function engineRootFromWebEnv(
  env: { TELAR_HOME?: string; TELAR_COCKPIT?: string } = process.env as { TELAR_HOME?: string; TELAR_COCKPIT?: string },
): string {
  if (env.TELAR_COCKPIT !== "1") {
    throw new EngineClientError("engine_unavailable", "Start the cockpit with bun run dev; ordinary web mode cannot access engine state.");
  }
  const telarHome = env.TELAR_HOME?.trim();
  if (!telarHome || !path.isAbsolute(telarHome)) {
    throw new EngineClientError(
      "engine_unavailable",
      "Set an absolute TELAR_HOME for the engine before opening the cockpit.",
    );
  }
  const canonicalHome = canonicalPath(telarHome);
  if (isLegacyTelarHome(canonicalHome)) {
    throw new EngineClientError(
      "engine_unavailable",
      "TELAR_HOME must not point at legacy Telar state; choose a dedicated Telar directory.",
    );
  }
  // Must stay the same subdirectory `engineRootFromEnv` (apps/engine/src/platform/fs/engine-root.ts)
  // composes. The engine MIGRATES this directory on boot; the cockpit only reads
  // it, so it deliberately does not — a client that renamed the store would race
  // the process that owns it.
  return path.join(canonicalHome, "engine");
}

export async function engineClient(): Promise<EngineClient> {
  return connectEngine(engineRootFromWebEnv());
}

const statusByCode: Record<EngineErrorCode, number> = {
  engine_unavailable: 503,
  engine_unauthorized: 502,
  engine_locked: 503,
  protocol_mismatch: 409,
  invalid_request: 400,
  not_found: 404,
  conflict: 409,
  worker_unavailable: 503,
  provider_unavailable: 503,
  driver_failed: 502,
  // 502 like `driver_failed`: this cockpit is fine, the harness behind the
  // one-shot completion did not answer.
  textgen_failed: 502,
  plugin_error: 400,
  internal_error: 500,
};

function engineErrorResponse(error: unknown): Response {
  if (error instanceof EngineClientError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: statusByCode[error.code] },
    );
  }
  return Response.json(
    { error: { code: "internal_error", message: "The engine adapter failed." } },
    { status: 500 },
  );
}

/** Wraps a route handler so anything it throws answers as `engineErrorResponse` does. */
export function engineRoute<A extends unknown[]>(handler: (...args: A) => Promise<Response>): (...args: A) => Promise<Response> {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      return engineErrorResponse(error);
    }
  };
}

/** For `throw invalidRequest(…)` inside an `engineRoute`: answers 400 with the message. */
export function invalidRequest(message: string): EngineClientError {
  return new EngineClientError("invalid_request", message);
}

/** File bytes as the cockpit reads them: never cached, never sniffed into something executable. */
export function bytesResponse({ data, contentType }: { data: Uint8Array; contentType: string }): Response {
  return new Response(new Uint8Array(data).buffer as ArrayBuffer, {
    headers: { "content-type": contentType, "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

export async function requestObject(request: Request): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await request.json();
    if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch {
    throw new EngineClientError("invalid_request", "Request body must be a JSON object.");
  }
}

export type PluginDoorMethod = "GET" | "POST" | "DELETE";

/**
 * A plugin's project or machine verb, spoken with the client's discovery and token since the client names only the session door.
 * The engine's status comes back unchanged; a refusal throws the same `EngineClientError` the client would.
 */
export async function enginePluginDoor(
  scope: { projectId: string } | "machine",
  pluginId: string,
  verb: readonly string[],
  method: PluginDoorMethod,
  options: { search?: string; body?: Record<string, unknown> } = {},
): Promise<Response> {
  const base = scope === "machine" ? "/v2/plugins" : `/v2/projects/${encodeURIComponent(scope.projectId)}/plugins`;
  const pathname = `${base}/${encodeURIComponent(pluginId)}/${verb.map(encodeURIComponent).join("/")}${options.search ?? ""}`;
  const response = await engineFetch(method, pathname, options.body === undefined ? {} : { body: JSON.stringify(options.body) });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new EngineClientError("engine_unavailable", "engine returned an invalid response", response.status);
  }
  if (!response.ok) {
    const error = (payload as { error?: { code?: EngineErrorCode; message?: string } } | null)?.error;
    throw new EngineClientError(error?.code ?? "engine_unavailable", error?.message ?? "engine request failed", response.status);
  }
  return Response.json(payload, { status: response.status });
}

export function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new EngineClientError("invalid_request", `${label} is required.`);
  }
  return value;
}

export function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, label);
}

const FORWARDED_HEADERS = ["content-type", "etag", "cache-control"];

type EngineAnswer = { status: number; body: unknown; headers: Headers };

type FetchInit = { body?: string; headers?: Record<string, string>; signal?: AbortSignal };

async function engineFetch(method: string, pathname: string, init: FetchInit = {}): Promise<Response> {
  const { discovery } = await engineClient();
  const headers = new Headers({ authorization: `Bearer ${discovery.token}`, ...init.headers });
  if (init.body !== undefined) headers.set("content-type", "application/json");
  try {
    return await fetch(`http://${discovery.host}:${discovery.port}${pathname}`, {
      method,
      headers,
      ...(init.body === undefined ? {} : { body: init.body }),
      ...(init.signal ? { signal: init.signal } : {}),
    });
  } catch {
    throw new EngineClientError("engine_unavailable", "engine is unreachable");
  }
}

/** Engine errors with an engine code are mapped as every proxy maps them; any other refusal is the route's own and passes through. */
async function answerOf(response: Response): Promise<EngineAnswer> {
  const json = response.headers.get("content-type")?.includes("json") ?? false;
  const body = response.status === 304 ? null : json ? await response.json().catch(() => null) : await response.arrayBuffer();
  if (response.status >= 400) {
    const error = (body as { error?: { code?: string; message?: string } } | null)?.error;
    if (!error?.code || error.code in statusByCode) {
      const code = (error?.code as EngineErrorCode | undefined) ?? "engine_unavailable";
      throw new EngineClientError(code, error?.message ?? "engine request failed", response.status);
    }
  }
  return { status: response.status, body, headers: response.headers };
}

/** Calls the engine and returns its answer for a route that composes a response of its own. */
export async function engineCall(method: string, pathname: string, body?: unknown): Promise<EngineAnswer> {
  return answerOf(await engineFetch(method, pathname, body === undefined ? {} : { body: JSON.stringify(body) }));
}

const SSE_HEADERS = { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" };

/** Sends `request` to the engine at `pathname` (query included) and answers with its status, body and caching headers; an event stream passes through unbuffered until the caller disconnects. */
export const engineForward = engineRoute(async (request: Request, pathname: string) => {
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const ifNoneMatch = request.headers.get("if-none-match");
  const response = await engineFetch(request.method, pathname, {
    ...(hasBody ? { body: (await request.text()) || "{}" } : {}),
    ...(ifNoneMatch ? { headers: { "if-none-match": ifNoneMatch } } : {}),
    signal: request.signal,
  });
  if (response.ok && response.body && response.headers.get("content-type")?.includes("text/event-stream")) {
    return new Response(response.body, { status: response.status, headers: SSE_HEADERS });
  }
  const answer = await answerOf(response);
  const out = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = answer.headers.get(name);
    if (value) out.set(name, value);
  }
  if (answer.status === 304) return new Response(null, { status: 304, headers: out });
  if (answer.body instanceof ArrayBuffer) return new Response(answer.body, { status: answer.status, headers: out });
  return Response.json(answer.body, { status: answer.status, headers: out });
});

/** Forwards `/api/<path>` to the engine's `/v2/<path>` unchanged, for routes whose paths mirror the engine's. */
export function engineProxy(request: Request): Promise<Response> {
  const { pathname, search } = new URL(request.url);
  return engineForward(request, `${pathname.replace(/^\/api\//, "/v2/")}${search}`);
}

/** Streams `request` to the engine and its answer back unbuffered, for answers that may be a live stream. */
export async function enginePipe(request: Request, pathname: string): Promise<Response> {
  const { discovery } = await engineClient();
  const headers = new Headers(request.headers);
  for (const name of ["cookie", "host", "connection", "content-length"]) headers.delete(name);
  headers.set("authorization", `Bearer ${discovery.token}`);
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  let answer: Response;
  try {
    answer = await fetch(`http://${discovery.host}:${discovery.port}${pathname}`, {
      method: request.method,
      headers,
      ...(hasBody ? { body: request.body, duplex: "half" } : {}),
      redirect: "manual",
      signal: request.signal,
    } as RequestInit);
  } catch {
    throw new EngineClientError("engine_unavailable", "engine is unreachable");
  }
  const out = new Headers(answer.headers);
  for (const name of ["content-encoding", "content-length", "transfer-encoding", "connection"]) out.delete(name);
  return new Response(answer.body, { status: answer.status, statusText: answer.statusText, headers: out });
}
