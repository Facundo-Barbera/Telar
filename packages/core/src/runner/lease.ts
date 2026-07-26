// THE lease primitive — one record, one write path, TWO lifetimes (AD-16).
//
// A lease is a disk claim on an owner's directory: "a live process owns this".
// It is the primary liveness oracle whenever execution leaves the web process.
// The record is `{pid, token, ts}`, written atomically (tmp + rename) so a
// reader never sees a half-written lease, and refreshed by a heartbeat from the
// owner's own loop. There is no daemon, no sweeper and no timer anywhere in
// this module — `heartbeatLease` is called by whoever holds the lease.
//
// THE TWO LIFETIMES, deliberately one implementation:
//   loom    — `<TELAR_HOME>/looms/<id>/.runner-lease`. Written by the runner
//             while it owns a loom; dies at land. A fresh lease means "a live
//             runner is on this loom" even when the runner's control socket is
//             briefly unreachable, so recovery never strands a loom a running
//             runner owns (R1).
//   session — `<TELAR_HOME>/sessions/<sessionId>/.runner-lease` (sessions.ts).
//             Same record, same functions, same reclaim rule; dies at session
//             close.
// Every function here takes a BARE DIRECTORY, never a loom id, and this module
// deliberately does not import looms.ts. That is what makes the second lifetime
// a second ROOT rather than a second implementation. If you find yourself
// writing a second stale-reclaim, stop — two stale-reclaims is the documented
// path by which a false `done` gets issued.
//
// THE FILENAME IS `.runner-lease` ON BOTH PATHS and must stay that way. The
// word "runner" is historical — this is the lease, not the runner's lease — but
// real loom trees already hold a `.runner-lease` on disk and a rename would
// orphan them. One filename, one shape, zero divergence.
//
// MOAT. A STALE lease can at worst produce a false-positive `failed`
// (human-recoverable) — NEVER an auto-`done`. `leaseReclaim` below makes that
// structural rather than careful: its return union has no member that can
// express a terminal success.
import fs from "node:fs";
import path from "node:path";

// Injectable fs slice + clock so tests never touch the real ~/.telar.
export type LeaseFs = Pick<typeof fs, "writeFileSync" | "readFileSync" | "mkdirSync" | "renameSync">;

export type RunnerLease = { pid: number; token: string; ts: number };

// Default lease-file locator. The caller passes the OWNER's directory — a loom
// root or a session root; this module neither knows nor cares which, which is
// the whole point (AD-16). Matches loomDir's layout without importing it, so
// tests can point the state root wherever.
export const leaseFile = (ownerDir: string): string => path.join(ownerDir, ".runner-lease");

// Atomic write (tmp + rename) so a reader never sees a half-written lease.
// Inlines the idiom rather than using manifest.ts's atomicWrite because it needs
// the injectable LeaseFs seam that helper does not offer.
export function writeLease(
  ownerDir: string,
  lease: { pid: number; token: string },
  now: () => number = Date.now,
  io: LeaseFs = fs,
): RunnerLease {
  const full: RunnerLease = { pid: lease.pid, token: lease.token, ts: now() };
  io.mkdirSync(ownerDir, { recursive: true });
  const file = leaseFile(ownerDir);
  const tmp = file + ".tmp";
  io.writeFileSync(tmp, JSON.stringify(full));
  io.renameSync(tmp, file);
  return full;
}

// Refresh only the timestamp (keep pid/token), re-asserting ownership. Returns
// the new lease, or null if there is no lease to heartbeat.
export function heartbeatLease(
  ownerDir: string,
  now: () => number = Date.now,
  io: LeaseFs = fs,
): RunnerLease | null {
  const cur = readLease(ownerDir, io);
  if (!cur) return null;
  return writeLease(ownerDir, { pid: cur.pid, token: cur.token }, now, io);
}

export function readLease(ownerDir: string, io: LeaseFs = fs): RunnerLease | null {
  try {
    const raw = io.readFileSync(leaseFile(ownerDir), "utf8");
    const data = JSON.parse(String(raw));
    if (typeof data?.pid === "number" && typeof data?.token === "string" && typeof data?.ts === "number") {
      return data as RunnerLease;
    }
    return null;
  } catch {
    return null; // absent / unreadable / malformed → no lease
  }
}

// A lease is FRESH (a live owner is on it) if its heartbeat is within ttlMs of
// now. A null lease is never fresh. Pure — clock injected by the caller.
export function isLeaseFresh(lease: RunnerLease | null, ttlMs: number, now: number): boolean {
  if (!lease) return false;
  return now - lease.ts <= ttlMs;
}

// MOAT: no branch here can return a terminal-SUCCESS. leaseReclaim only ever
// yields held / reclaimable — never `done`. The union is the guarantee: there
// is no member that can express a completed unit of work, so a stale lease on
// EITHER lifetime can at worst hand its owner's slot to someone else, and the
// worst downstream outcome remains a false-positive `failed`, which a human can
// recover. This mirrors recover.ts's reconcileState, whose own comment reads
// "MOAT: no branch here can return a terminal-SUCCESS."
//
//   held        — a live owner is on it; leave it alone.
//   reclaimable — no fresh heartbeat; the directory may be re-claimed.
export type LeaseReclaim = "held" | "reclaimable";

// Every value the union can take, in one place, so a test can enumerate the
// whole outcome space and assert that `done` is not among them. A behavioral
// test alone would pass on a union that merely happens not to return `done`
// today.
export const LEASE_RECLAIM_OUTCOMES: readonly LeaseReclaim[] = ["held", "reclaimable"] as const;

// PURE — the clock is a parameter, never read here. Deliberately a WRAPPER over
// isLeaseFresh rather than a re-derivation of `now - lease.ts <= ttlMs`:
// re-deriving that comparison is the "second stale-reclaim" in its smallest and
// most innocent-looking form, and the moat depends on there being exactly one.
//
// `ttlMs` stays a caller-supplied parameter. There is no global TTL constant in
// production source and this does not invent one — how long a heartbeat gap
// means "dead" is a per-owner decision, not a property of the primitive.
export function leaseReclaim(
  lease: RunnerLease | null,
  ttlMs: number,
  now: number,
): LeaseReclaim {
  return isLeaseFresh(lease, ttlMs, now) ? "held" : "reclaimable";
}
