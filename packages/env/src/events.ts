import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { envStateDir } from "./paths.ts";

export type EnvEventType =
  | "lease.granted"
  | "lease.renewed"
  | "lease.queued"
  | "lease.released"
  | "lease.reclaimed"
  | "env.kept-warm"
  | "env.warm-reused"
  | "env.warm-expired"
  | "env.warm-evicted";

/**
 * Append-only journal of scheduler decisions. This is the data a future UI
 * (or an agent asking "what happened to my lease?") reads — the scheduler
 * itself never reads it back.
 */
export function recordEvent(type: EnvEventType, data: Record<string, unknown>): void {
  try {
    mkdirSync(envStateDir(), { recursive: true });
    appendFileSync(
      join(envStateDir(), "events.jsonl"),
      `${JSON.stringify({ at: new Date().toISOString(), type, ...data })}\n`,
    );
  } catch {
    // The journal is best-effort; scheduling never fails because logging did.
  }
}
