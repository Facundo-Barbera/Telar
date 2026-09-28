import type { EngineErrorCode } from "../protocol/events";

/** The errno-shaped code a few links down a fetch failure's `cause` chain, with the error's name. */
export function sanitizeTransportCause(cause: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current = cause;
  let name: string | undefined;
  for (let depth = 0; depth < 5 && current !== null && typeof current === "object"; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    const record = current as { name?: unknown; code?: unknown; cause?: unknown };
    if (name === undefined && typeof record.name === "string" && /^[A-Za-z]{1,40}$/.test(record.name)) name = record.name;
    if (typeof record.code === "string" && /^[A-Z][A-Z0-9_]{1,31}$/.test(record.code)) return name ? `${name}:${record.code}` : record.code;
    current = record.cause;
  }
  return name;
}

export class EngineClientError extends Error {
  readonly code: EngineErrorCode;
  readonly status?: number;
  readonly operation?: string;
  /** The sanitized transport cause; absent on an HTTP error, which has a status. */
  readonly transport?: string;

  constructor(code: EngineErrorCode, message: string, status?: number, details?: { operation?: string; transport?: string }) {
    super(message);
    this.name = "EngineClientError";
    this.code = code;
    this.status = status;
    if (details?.operation !== undefined) this.operation = details.operation;
    if (details?.transport !== undefined) this.transport = details.transport;
  }
}
