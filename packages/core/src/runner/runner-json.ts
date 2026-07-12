// M5 runner discovery + single-instance guard. `~/.telar/runner.json`
// ({pid,port,token}, mode 0600) is how the web finds a live runner; the
// `O_EXCL` `runner.lock` (flag:"wx", the same primitive startLoomFromBundle's
// `.started` sentinel uses) keeps exactly one runner alive. All fs is injected
// so tests exercise the lock/reclaim logic against a fake — never real ~/.telar.
import fs from "node:fs";
import path from "node:path";

export type RunnerJson = { pid: number; port: number; token: string };

// The fs surface these helpers need. `writeFileSync` honors the {flag,mode}
// options object; a fake must too (that's where O_EXCL lives).
export type RunnerFs = Pick<typeof fs, "writeFileSync" | "readFileSync" | "mkdirSync" | "unlinkSync">;

export const runnerJsonPath = (telarDir: string): string => path.join(telarDir, "runner.json");
export const runnerLockPath = (telarDir: string): string => path.join(telarDir, "runner.lock");

// Persist runner identity for the web to discover. 0600 — the token is a
// bearer credential for the loopback control channel.
export function writeRunnerJson(telarDir: string, info: RunnerJson, io: RunnerFs = fs): void {
  io.mkdirSync(telarDir, { recursive: true });
  io.writeFileSync(runnerJsonPath(telarDir), JSON.stringify(info), { mode: 0o600 });
}

export function readRunnerJson(telarDir: string, io: RunnerFs = fs): RunnerJson | null {
  try {
    const data = JSON.parse(String(io.readFileSync(runnerJsonPath(telarDir), "utf8")));
    if (typeof data?.pid === "number" && typeof data?.port === "number" && typeof data?.token === "string") {
      return data as RunnerJson;
    }
    return null;
  } catch {
    return null;
  }
}

// Single-instance guard. O_EXCL create of runner.lock: the FIRST writer wins;
// a concurrent second caller's `wx` create fails → returns false (do not
// spawn). `pid` is stamped so a recycled-pid reclaim can distinguish a truly
// dead owner from a live one. Returns true iff this caller acquired the lock.
export function acquireRunnerLock(telarDir: string, pid: number, io: RunnerFs = fs): boolean {
  io.mkdirSync(telarDir, { recursive: true });
  try {
    io.writeFileSync(runnerLockPath(telarDir), String(pid), { flag: "wx" });
    return true;
  } catch {
    return false; // lock already held
  }
}

export function releaseRunnerLock(telarDir: string, io: RunnerFs = fs): void {
  try {
    io.unlinkSync(runnerLockPath(telarDir));
  } catch {
    // already gone — release is idempotent
  }
}

// R4 stale-runner reclaim: a crashed runner leaves a lock/json behind. If the
// recorded pid is dead (or the pid was recycled onto a DIFFERENT process, per
// the caller's `isAlive` probe), the lock is stale — force-replace it so the
// next runner reclaims cleanly instead of refusing forever. `isAlive` is
// injected (a real runner checks `process.kill(pid, 0)` + a /health identity
// echo). Returns true iff the lock was reclaimed for `pid`.
export function reclaimStaleLock(
  telarDir: string,
  pid: number,
  isAlive: (ownerPid: number) => boolean,
  io: RunnerFs = fs,
): boolean {
  let ownerPid: number | null = null;
  try {
    ownerPid = Number(String(io.readFileSync(runnerLockPath(telarDir), "utf8")).trim());
  } catch {
    ownerPid = null; // no lock file — nothing to reclaim, caller acquires fresh
  }
  if (ownerPid !== null && Number.isFinite(ownerPid) && isAlive(ownerPid)) {
    return false; // a live owner holds it — do not steal
  }
  releaseRunnerLock(telarDir, io);
  return acquireRunnerLock(telarDir, pid, io);
}
