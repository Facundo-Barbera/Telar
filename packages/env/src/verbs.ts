import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import type { EnvContract } from "./config.ts";

export interface VerbContext {
  projectId: string;
  worktree: string;
  slot: number;
  portBase: number;
  leaseId?: string;
}

export interface VerbResult {
  verb: string;
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  /** Tail of combined output, for error reporting. */
  output: string;
}

const TIMEOUTS_MS: Record<string, number> = {
  up: 300_000,
  ready: 30_000,
  reset: 120_000,
  down: 120_000,
  verify: 600_000,
};

function injectedEnv(ctx: VerbContext): Record<string, string | undefined> {
  return {
    ...process.env,
    TELAR_PROJECT_ID: ctx.projectId,
    TELAR_WORKTREE: ctx.worktree,
    TELAR_SLOT: String(ctx.slot),
    TELAR_PORT_BASE: String(ctx.portBase),
    ...(ctx.leaseId ? { TELAR_LEASE_ID: ctx.leaseId } : {}),
  };
}

/** Run one contract verb in the worktree with the TELAR_* variables injected. */
export function runVerb(
  verb: keyof EnvContract & string,
  command: string,
  ctx: VerbContext,
): Promise<VerbResult> {
  const started = Date.now();
  const timeout = TIMEOUTS_MS[verb] ?? 120_000;
  return new Promise((resolvePromise) => {
    const proc = spawn("/bin/sh", ["-c", command], {
      cwd: ctx.worktree,
      env: injectedEnv(ctx),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let combined = "";
    proc.stdout.on("data", (d: Buffer) => (combined += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (combined += d.toString()));
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeout);
    proc.on("close", (exitCode) => {
      clearTimeout(timer);
      const trimmed = combined.trim();
      resolvePromise({
        verb,
        ok: exitCode === 0,
        exitCode,
        durationMs: Date.now() - started,
        output: trimmed.length > 4000 ? trimmed.slice(-4000) : trimmed,
      });
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({
        verb,
        ok: false,
        exitCode: null,
        durationMs: Date.now() - started,
        output: String(err),
      });
    });
  });
}

/** Poll `ready` until it exits 0 or the deadline passes. */
export async function waitReady(
  command: string,
  ctx: VerbContext,
  timeoutMs = 180_000,
  intervalMs = 2_000,
): Promise<VerbResult> {
  const deadline = Date.now() + timeoutMs;
  let last: VerbResult;
  for (;;) {
    last = await runVerb("ready", command, ctx);
    if (last.ok || Date.now() >= deadline) return last;
    await sleep(intervalMs);
  }
}
