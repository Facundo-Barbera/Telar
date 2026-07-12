// M5 per-loom disk lease — the primary liveness oracle when execution leaves
// the web process. The runner heartbeats `~/.telar/looms/<id>/.runner-lease`
// while it owns a loom; a fresh lease means "a live runner is on this loom"
// even when the runner's control socket is briefly unreachable, so recovery
// never strands a loom a running runner owns (R1). A STALE lease can at worst
// produce a false-positive failed (human-recoverable) — never an auto-done.
import fs from "node:fs";
import path from "node:path";

// Injectable fs slice + clock so tests never touch the real ~/.telar.
export type LeaseFs = Pick<typeof fs, "writeFileSync" | "readFileSync" | "mkdirSync" | "renameSync">;

export type RunnerLease = { pid: number; token: string; ts: number };

// Default lease-file locator (matches loomDir's layout without importing it, so
// tests can point HOME wherever). The caller passes the loom dir.
export const leaseFile = (loomDir: string): string => path.join(loomDir, ".runner-lease");

// Atomic write (tmp + rename) so a reader never sees a half-written lease.
export function writeLease(
  loomDir: string,
  lease: { pid: number; token: string },
  now: () => number = Date.now,
  io: LeaseFs = fs,
): RunnerLease {
  const full: RunnerLease = { pid: lease.pid, token: lease.token, ts: now() };
  io.mkdirSync(loomDir, { recursive: true });
  const file = leaseFile(loomDir);
  const tmp = file + ".tmp";
  io.writeFileSync(tmp, JSON.stringify(full));
  io.renameSync(tmp, file);
  return full;
}

// Refresh only the timestamp (keep pid/token), re-asserting ownership. Returns
// the new lease, or null if there is no lease to heartbeat.
export function heartbeatLease(
  loomDir: string,
  now: () => number = Date.now,
  io: LeaseFs = fs,
): RunnerLease | null {
  const cur = readLease(loomDir, io);
  if (!cur) return null;
  return writeLease(loomDir, { pid: cur.pid, token: cur.token }, now, io);
}

export function readLease(loomDir: string, io: LeaseFs = fs): RunnerLease | null {
  try {
    const raw = io.readFileSync(leaseFile(loomDir), "utf8");
    const data = JSON.parse(String(raw));
    if (typeof data?.pid === "number" && typeof data?.token === "string" && typeof data?.ts === "number") {
      return data as RunnerLease;
    }
    return null;
  } catch {
    return null; // absent / unreadable / malformed → no lease
  }
}

// A lease is FRESH (a live runner is on it) if its heartbeat is within ttlMs of
// now. A null lease is never fresh. Pure — clock injected by the caller.
export function isLeaseFresh(lease: RunnerLease | null, ttlMs: number, now: number): boolean {
  if (!lease) return false;
  return now - lease.ts <= ttlMs;
}
