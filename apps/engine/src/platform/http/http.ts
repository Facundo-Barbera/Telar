import type http from "node:http";
import type { EngineErrorCode } from "@telar/engine-client";
import { EngineStateError } from "../kernel/errors";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: EngineErrorCode,
    message: string,
    // For a refusal that skipped reading the body: keep-alive would leave the unread bytes on the socket.
    readonly endConnection = false,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** `known` maps a domain's own error class; anything unrecognised becomes a 500. */
export function errorFor(error: unknown, known?: (error: unknown) => HttpError | undefined): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof EngineStateError) {
    return new HttpError(error.code === "not_found" ? 404 : error.code === "conflict" ? 409 : 400, error.code, error.message);
  }
  return known?.(error) ?? new HttpError(500, "internal_error", "engine encountered an internal error");
}

export function writeJson(response: http.ServerResponse, status: number, body: unknown, headers: http.OutgoingHttpHeaders = {}): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  response.end(JSON.stringify(body));
}

export function writeError(response: http.ServerResponse, error: HttpError): void {
  writeJson(response, error.status, { error: { code: error.code, message: error.message } }, error.endConnection ? { connection: "close" } : {});
}

// Weak comparison, as RFC 9110 requires of `If-None-Match`: a list, `W/` ignored, `*` matches anything.
export function matchesETag(header: string | string[] | undefined, tag: string): boolean {
  if (header === undefined) return false;
  const bare = (value: string): string => value.trim().replace(/^W\//, "");
  const wanted = bare(tag);
  for (const entry of (Array.isArray(header) ? header : [header]).flatMap((value) => value.split(","))) {
    const candidate = bare(entry);
    if (candidate === "*" || candidate === wanted) return true;
  }
  return false;
}

export async function body(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > 1_000_000) throw new HttpError(400, "invalid_request", "request body is too large");
    chunks.push(buffer);
  }
  if (total === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new HttpError(400, "invalid_request", "request body must be an object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "invalid_request", "request body is invalid JSON");
  }
}
