import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CostClass } from "./config.ts";
import { envStateDir, lockDirPath, stateFilePath } from "./paths.ts";

export interface Lease {
  id: string;
  projectId: string;
  worktree: string;
  slot: number;
  portBase: number;
  cost: CostClass;
  pid: number;
  createdAt: number;
  expiresAt: number;
}

export interface QueueEntry {
  projectId: string;
  worktree: string;
  requestedAt: number;
}

/** A released environment left running so the next lease on it skips `up`. */
export interface WarmEnv {
  projectId: string;
  worktree: string;
  slot: number;
  portBase: number;
  cost: CostClass;
  since: number;
}

export interface EnvState {
  version: 1;
  /** worktree path → slot number, per project. Slot 0 is the primary checkout. */
  slots: Record<string, Record<string, number>>;
  /** "<projectId>/<slot>" → reserved port base (machine-global, never reused across projects). */
  ports: Record<string, number>;
  nextPortOrdinal: number;
  leases: Record<string, Lease>;
  /** FIFO of worktrees waiting for a heavy-pool slot. */
  queue: QueueEntry[];
  /** "<projectId>/<worktree>" → environment kept warm after release. Counts against the pool. */
  warm: Record<string, WarmEnv>;
}

const EMPTY: EnvState = { version: 1, slots: {}, ports: {}, nextPortOrdinal: 0, leases: {}, queue: [], warm: {} };

function readState(): EnvState {
  const path = stateFilePath();
  if (!existsSync(path)) return structuredClone(EMPTY);
  const state = JSON.parse(readFileSync(path, "utf8")) as EnvState;
  state.warm ??= {};
  return state;
}

function writeState(state: EnvState): void {
  mkdirSync(envStateDir(), { recursive: true });
  const tmp = join(envStateDir(), `state.json.tmp-${process.pid}`);
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, stateFilePath());
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const LOCK_STALE_MS = 30_000;

function acquireLock(): void {
  const lock = lockDirPath();
  mkdirSync(envStateDir(), { recursive: true });
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, "owner"), JSON.stringify({ pid: process.pid, at: Date.now() }));
      return;
    } catch {
      try {
        const owner = JSON.parse(readFileSync(join(lock, "owner"), "utf8")) as { pid: number; at: number };
        if (!pidAlive(owner.pid) || Date.now() - owner.at > LOCK_STALE_MS) {
          releaseLock();
          continue;
        }
      } catch {
        // Owner file mid-write or gone; brief wait then retry.
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for state lock at ${lock}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

function releaseLock(): void {
  const lock = lockDirPath();
  try {
    rmSync(join(lock, "owner"), { force: true });
    rmdirSync(lock);
  } catch {
    // Already released.
  }
}

/** Run a read-modify-write transaction against the shared state file. */
export function withState<T>(fn: (state: EnvState) => T): T {
  acquireLock();
  try {
    const state = readState();
    const result = fn(state);
    writeState(state);
    return result;
  } finally {
    releaseLock();
  }
}

/** Read-only snapshot (still locks, so a snapshot is never torn). */
export function snapshotState(): EnvState {
  return withState((s) => structuredClone(s));
}

export { pidAlive };
