import { EngineClientError, type EngineErrorCode } from "@telar/engine-client";
import { engineClient, engineErrorResponse, statusByCode } from "./engine-server";

const FORWARDED_HEADERS = ["content-type", "etag", "cache-control"];

type EngineAnswer = { status: number; body: unknown; headers: Headers };

async function engineFetch(method: string, pathname: string, init: { body?: string; headers?: Record<string, string> } = {}): Promise<Response> {
  const { discovery } = await engineClient();
  const headers = new Headers({ authorization: `Bearer ${discovery.token}`, ...init.headers });
  if (init.body !== undefined) headers.set("content-type", "application/json");
  try {
    return await fetch(`http://${discovery.host}:${discovery.port}${pathname}`, { method, headers, ...(init.body === undefined ? {} : { body: init.body }) });
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

/** Sends `request` to the engine at `pathname` (query included) and answers with its status, body and caching headers. */
export async function engineForward(request: Request, pathname: string): Promise<Response> {
  try {
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const ifNoneMatch = request.headers.get("if-none-match");
    const answer = await answerOf(
      await engineFetch(request.method, pathname, {
        ...(hasBody ? { body: (await request.text()) || "{}" } : {}),
        ...(ifNoneMatch ? { headers: { "if-none-match": ifNoneMatch } } : {}),
      }),
    );
    const out = new Headers();
    for (const name of FORWARDED_HEADERS) {
      const value = answer.headers.get(name);
      if (value) out.set(name, value);
    }
    if (answer.status === 304) return new Response(null, { status: 304, headers: out });
    if (answer.body instanceof ArrayBuffer) return new Response(answer.body, { status: answer.status, headers: out });
    return Response.json(answer.body, { status: answer.status, headers: out });
  } catch (error) {
    return engineErrorResponse(error);
  }
}
