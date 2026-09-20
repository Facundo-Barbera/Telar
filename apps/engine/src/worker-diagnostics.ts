/**
 * WHERE THE WORKER'S CONNECTIVITY EVIDENCE GOES.
 *
 * The sink defaulted to `process.stderr`, and the installed app's stdout and
 * stderr are `/dev/null` — so when a worker reported losing contact with its
 * own engine, every record of why was written to nothing and the incident could
 * not be attributed afterwards. A diagnostic that only exists when someone is
 * watching a terminal is not a diagnostic.
 *
 * Three properties, in order of importance:
 *
 *   SECRET-FREE BY CONSTRUCTION. Fields are PICKED, never spread, and every
 *   string is length-capped here rather than trusted from the caller. An
 *   upstream change that started carrying a URL or a header cannot leak through
 *   this file, because this file does not copy what it does not name.
 *
 *   BOUNDED. Rotation is checked BEFORE the write, against the projected size,
 *   so the cap is a real ceiling rather than one exceeded by the last line. One
 *   previous generation is kept; total on disk cannot exceed twice the cap.
 *
 *   BEST-EFFORT. Every failure is swallowed. A worker must not destabilise
 *   because a log line could not be written.
 */
import fs from "node:fs";
import path from "node:path";
import { statePaths } from "./state";

/** The only fields that cross. Anything else a caller passes is dropped. */
export type WorkerDiagnostic = {
  event: string;
  operation?: string;
  code?: string;
  status?: number;
  transport?: string;
  outageMs?: number;
  /** How long the event being reported took, in ms. Added for #409's stop
   *  timeline, where the question is never "did it happen" but "how late". */
  elapsedMs?: number;
};

/** Per-field cap. Every value here is an identifier, an enum or a small number;
 *  none has a legitimate reason to be long, so a long one is a bug or a leak. */
const MAX_FIELD = 96;
/** Per-line cap, enforced after encoding so a pathological record is dropped
 *  rather than written. */
const MAX_LINE = 512;
/** Rotate at this size; with one kept generation the ceiling is twice this. */
const MAX_BYTES = 1_048_576;

const text = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.length === 0) return undefined;
  // Control characters would break the one-line-per-record shape, and are not
  // something any legitimate value here contains.
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  return clean.length > MAX_FIELD ? clean.slice(0, MAX_FIELD) : clean;
};

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;

/** The record as it will be written: named fields only, each narrowed. */
export function sanitizeDiagnostic(workerId: string, at: string, fields: WorkerDiagnostic): Record<string, unknown> {
  const event = text(fields.event) ?? "unknown";
  return {
    at,
    workerId: text(workerId) ?? "unknown",
    event,
    ...(text(fields.operation) ? { operation: text(fields.operation) } : {}),
    ...(text(fields.code) ? { code: text(fields.code) } : {}),
    ...(count(fields.status) === undefined ? {} : { status: count(fields.status) }),
    ...(text(fields.transport) ? { transport: text(fields.transport) } : {}),
    ...(count(fields.outageMs) === undefined ? {} : { outageMs: count(fields.outageMs) }),
    ...(count(fields.elapsedMs) === undefined ? {} : { elapsedMs: count(fields.elapsedMs) }),
  };
}

/**
 * A sink that appends to `<root>/diagnostics/worker.jsonl`, rotating before the
 * cap. Returns a function shaped exactly like `EngineWorkerOptions.onDiagnostic`.
 */
export function createWorkerDiagnostics(root: string, workerId: string, now: () => number = Date.now): (fields: WorkerDiagnostic) => void {
  const directory = statePaths(root).diagnostics;
  const file = path.join(directory, "worker.jsonl");
  const previous = `${file}.1`;
  return (fields) => {
    try {
      const line = `${JSON.stringify(sanitizeDiagnostic(workerId, new Date(now()).toISOString(), fields))}\n`;
      // A record that cannot fit the line cap is dropped rather than truncated:
      // half a JSON object is not parseable and not evidence.
      if (Buffer.byteLength(line) > MAX_LINE) return;
      fs.mkdirSync(directory, { recursive: true });
      // BEFORE the write, against the projected size — checking afterwards
      // makes the cap something the last line always exceeds.
      let size = 0;
      try {
        size = fs.statSync(file).size;
      } catch {
        // No file yet.
      }
      if (size + Buffer.byteLength(line) > MAX_BYTES) {
        try {
          fs.rmSync(previous, { force: true });
          fs.renameSync(file, previous);
        } catch {
          // A rotation that could not happen must not stop the write; the next
          // one will try again.
        }
      }
      fs.appendFileSync(file, line);
    } catch {
      // Best-effort, always. Losing a diagnostic is bad; a worker that falls
      // over because it could not write one is worse.
    }
  };
}
