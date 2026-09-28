import os from "node:os";

// A provider process waits on a model, so memory binds, not CPU: half of RAM at 512 MB a turn.
// The ceiling is where the daemon's single event loop stops keeping up with observation traffic.
const WORKER_MEMORY_BUDGET_PER_TURN = 512 * 1024 * 1024;
const MIN_WORKER_CONCURRENCY = 4;
const MAX_WORKER_CONCURRENCY = 24;

/** Read once: the claim path asks for the cap on every tick. */
let physicalMemoryBytes: number | undefined;

export function defaultWorkerConcurrency(totalBytes: number = (physicalMemoryBytes ??= os.totalmem())): number {
  const affordable = Math.floor(totalBytes / 2 / WORKER_MEMORY_BUDGET_PER_TURN);
  return Math.min(MAX_WORKER_CONCURRENCY, Math.max(MIN_WORKER_CONCURRENCY, affordable));
}

/** Read by both worker construction sites so the embedded and standalone workers agree. */
export function workerConcurrencyFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.TELAR_WORKER_CONCURRENCY?.trim();
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
