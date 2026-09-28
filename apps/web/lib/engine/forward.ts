import { EngineClientError, type EngineErrorCode } from "@telar/engine-client";
import { engineClient, engineErrorResponse, statusByCode } from "./engine-server";

const FORWARDED_HEADERS = ["content-type", "etag", "cache-control"];

/** Sends `request` to the engine at `pathname` (query included) and answers with its status, body and caching headers. */
export async function engineForward(request: Request, pathname: string): Promise<Response> {
  try {
    const { discovery } = await engineClient();
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const headers = new Headers({ authorization: `Bearer ${discovery.token}` });
    const ifNoneMatch = request.headers.get("if-none-match");
    if (ifNoneMatch) headers.set("if-none-match", ifNoneMatch);
    if (hasBody) headers.set("content-type", request.headers.get("content-type") ?? "application/json");
    let response: Response;
    try {
      response = await fetch(`http://${discovery.host}:${discovery.port}${pathname}`, {
        method: request.method,
        headers,
        ...(hasBody ? { body: await request.text() } : {}),
      });
    } catch {
      throw new EngineClientError("engine_unavailable", "engine is unreachable");
    }
    if (response.status >= 400) {
      const payload = (await response.json().catch(() => null)) as { error?: { code?: EngineErrorCode; message?: string } } | null;
      const code = payload?.error?.code && payload.error.code in statusByCode ? payload.error.code : "engine_unavailable";
      throw new EngineClientError(code, payload?.error?.message ?? "engine request failed", response.status);
    }
    const out = new Headers();
    for (const name of FORWARDED_HEADERS) {
      const value = response.headers.get(name);
      if (value) out.set(name, value);
    }
    return new Response(response.status === 304 ? null : await response.arrayBuffer(), { status: response.status, headers: out });
  } catch (error) {
    return engineErrorResponse(error);
  }
}
