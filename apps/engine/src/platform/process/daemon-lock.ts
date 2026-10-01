import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { EngineStateError } from "../kernel";
import type { EngineStatePaths } from "../fs/state-paths";

/** What `main.ts` exits with when the lock is held, so the shell shows "already running" instead of a crash. The shell keeps a copy. */
export const ENGINE_EXIT_LOCK_HELD = 3;

export type DaemonLock = { token: string; release(): void };

type LockOwner = { pid?: number; hostname?: string; startedAt?: number; command?: string };

/** How the lock tells a live owner from a stale file. `command` and `bootTime` resolve to null when unknown. */
export type LockProbe = {
  alive(pid: number): boolean;
  command(pid: number): Promise<string | null>;
  bootTime(): Promise<number | null>;
  now(): number;
  log(line: string): void;
};

function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function run(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 2_000, encoding: "utf8" }, (error, stdout) => resolve(error && !stdout ? null : stdout));
  });
}

export function parseBootTime(platform: NodeJS.Platform, text: string | null): number | null {
  const seconds = platform === "darwin" ? text?.match(/sec\s*=\s*(\d+)/)?.[1] : text?.match(/^btime\s+(\d+)/m)?.[1];
  return seconds ? Number(seconds) * 1000 : null;
}

export const systemLockProbe: LockProbe = {
  alive: processExists,
  async command(pid) {
    const out = await run("ps", ["-ww", "-o", "args=", "-p", String(pid)]);
    return out === null ? null : out.trim();
  },
  async bootTime() {
    if (process.platform === "darwin") return parseBootTime("darwin", await run("sysctl", ["-n", "kern.boottime"]));
    if (process.platform === "linux") return parseBootTime("linux", await fs.promises.readFile("/proc/stat", "utf8").catch(() => null));
    return null;
  },
  now: Date.now,
  log: (line) => process.stderr.write(`${line}\n`),
};

// A lock from another machine is never stale: its pid says nothing about this kernel. No hostname means ours.
function lockHeldElsewhere(owner: LockOwner): boolean {
  return typeof owner.hostname === "string" && owner.hostname !== "" && owner.hostname !== os.hostname();
}

// Locks written before `command` was recorded fall back to the name; an unreadable command counts as the owner.
async function staleReason(owner: LockOwner, probe: LockProbe): Promise<string | null> {
  const pid = owner.pid ?? -1;
  if (!probe.alive(pid)) return `pid ${pid} is gone`;
  const boot = await probe.bootTime();
  if (boot !== null && typeof owner.startedAt === "number" && owner.startedAt < boot) return "it was written before this boot";
  const command = await probe.command(pid);
  if (command === "") return `pid ${pid} is gone`;
  if (command === null) return null;
  const engine = owner.command ? command === owner.command : /telar/i.test(command);
  return engine ? null : `pid ${pid} is now ${command}`;
}

function readLock(file: string): { owner: LockOwner; fingerprint: string } | null {
  try {
    const text = fs.readFileSync(file, "utf8");
    const stat = fs.statSync(file);
    let owner: LockOwner = {};
    try {
      owner = JSON.parse(text) as LockOwner;
    } catch {}
    return { owner, fingerprint: `${stat.dev}:${stat.ino}:${text}` };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function unlinkIfToken(file: string, token: string) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as { token?: string };
    if (value.token === token) fs.unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

// A breaker left by a crash mid-recovery would otherwise block every later start.
async function takeBreaker(breaker: string, token: string, probe: LockProbe): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = fs.openSync(breaker, "wx", 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token }));
      fs.closeSync(descriptor);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const boot = await probe.bootTime();
      const mtime = fs.statSync(breaker, { throwIfNoEntry: false })?.mtimeMs;
      if (attempt > 0 || boot === null || mtime === undefined || mtime >= boot) return false;
      fs.rmSync(breaker, { force: true });
    }
  }
  return false;
}

/** Exclusive state-root ownership. A stale lock (dead pid, a reused pid, or one from before this boot) is replaced; a live one never is. */
export async function acquireDaemonLock(paths: EngineStatePaths, probe: LockProbe = systemLockProbe): Promise<DaemonLock> {
  fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  const token = crypto.randomUUID();
  const breaker = `${paths.lock}.break`;
  const command = (await probe.command(process.pid)) || undefined;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const descriptor = fs.openSync(paths.lock, "wx", 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token, hostname: os.hostname(), startedAt: probe.now(), command }));
      fs.closeSync(descriptor);
      return { token, release: () => unlinkIfToken(paths.lock, token) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const seen = readLock(paths.lock);
    if (!seen) continue;
    const { owner } = seen;
    if (lockHeldElsewhere(owner)) throw new EngineStateError("conflict", `engine state root is locked by ${owner.hostname}`);
    const reason = await staleReason(owner, probe);
    // The pid is the only copy the shell gets to show; `(pid N)` keeps this refusal apart from the cross-host `locked by`.
    if (reason === null) throw new EngineStateError("conflict", `engine state root is already locked (pid ${owner.pid})`);
    const breakerToken = crypto.randomUUID();
    if (!(await takeBreaker(breaker, breakerToken, probe))) throw new EngineStateError("conflict", "engine state root is already being recovered");
    try {
      if (readLock(paths.lock)?.fingerprint !== seen.fingerprint) continue;
      fs.rmSync(paths.lock, { force: true });
      probe.log(`Telar engine: replaced a stale lock because ${reason} — ${paths.lock}`);
    } finally {
      unlinkIfToken(breaker, breakerToken);
    }
  }
  throw new EngineStateError("conflict", "engine state root is already locked");
}
