import fs from "node:fs";
import path from "node:path";
import { statePaths } from "../platform/fs/state-paths";

export type WorkerDiagnostic = {
  event: string;
  operation?: string;
  code?: string;
  status?: number;
  transport?: string;
  outageMs?: number;
  elapsedMs?: number;
};

const MAX_FIELD = 96;
const MAX_LINE = 512;
const MAX_BYTES = 1_048_576;

const text = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  return clean.length > MAX_FIELD ? clean.slice(0, MAX_FIELD) : clean;
};

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;

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

export function createWorkerDiagnostics(root: string, workerId: string, now: () => number = Date.now): (fields: WorkerDiagnostic) => void {
  const directory = statePaths(root).diagnostics;
  const file = path.join(directory, "worker.jsonl");
  const previous = `${file}.1`;
  return (fields) => {
    try {
      const line = `${JSON.stringify(sanitizeDiagnostic(workerId, new Date(now()).toISOString(), fields))}\n`;
      if (Buffer.byteLength(line) > MAX_LINE) return;
      fs.mkdirSync(directory, { recursive: true });
      let size = 0;
      try {
        size = fs.statSync(file).size;
      } catch {
      }
      if (size + Buffer.byteLength(line) > MAX_BYTES) {
        try {
          fs.rmSync(previous, { force: true });
          fs.renameSync(file, previous);
        } catch {
        }
      }
      fs.appendFileSync(file, line);
    } catch {
    }
  };
}
