// The session subtree — `<TELAR_HOME>/sessions/<sessionId>/` (AD-5, AD-16).
//
// WHAT LIVES HERE: session-scoped RUNTIME state — the lease, live-tail ephemera,
// and the crash-durable pending-turn queue. "Durable" here means accepted user
// intent survives renderer/process loss until it settles; it is still
// operational state with the session's lifetime, not transcript history.
//
// WHAT DOES NOT: `chats.json` keeps its own root-level home and is NOT absorbed
// into this tree. A session's transcript outlives the process that produced it;
// this directory is about who is running right now.
//
// A PRE-EXISTING CO-TENANT, recorded rather than papered over:
// `apps/web/lib/session-log.ts` already creates and writes this exact directory
// — `<TELAR_HOME>/sessions/<id>/live.ndjson`, the append-only live-tail of the
// current turn. Core owns the LEASE FILE; session-log.ts keeps owning
// `live.ndjson`; session-queue.ts owns `queue.json`. Different files, same
// directory, and `mkdirSync(…, {recursive: true})` is idempotent, so coexistence
// is safe. Two consequences worth stating
// out loud:
//   1. `sessionDir()` here must produce the BYTE-IDENTICAL path session-log.ts
//      produces, or the two split-brain the directory. It is pinned by a
//      literal-string assertion in session-lease.test.ts, not by comparing
//      against an import core cannot reach.
//   2. One DELIBERATE ASYMMETRY: this resolver guards the id against path
//      traversal and session-log.ts's does not. So core FAILS CLOSED on an id
//      session-log.ts would happily write. That is the safer direction, and it
//      is a stated choice rather than an accident.
//
// AD-16: the lease API below COMPOSES over runner/lease.ts — the one lease
// primitive, one record shape, one reclaim rule, two lifetimes. It does not
// reimplement any of it. If the word `renameSync` ever appears in this file,
// someone has written a second lease.
import fs from "node:fs";
import path from "node:path";
import { telarDir } from "./manifest";
import {
  heartbeatLease,
  leaseFile,
  leaseReclaim,
  readLease,
  writeLease,
  type LeaseFs,
  type LeaseReclaim,
  type RunnerLease,
} from "./runner/lease";

// `telarDir` is IMPORTED, not re-derived. Five like-for-like copies of the
// `process.env.TELAR_HOME?.trim()` expression already exist and their
// duplication is deliberate-and-separately-tracked; new core code takes the
// import instead (the vcs.ts precedent). A sixth copy is how the guard and the
// thing it guards end up reading different values.
export const sessionsDir = (): string => path.join(telarDir(), "sessions");

// Every consumer of a session's on-disk location routes through here, so this
// is the one place `sessionId` needs guarding against path traversal (an id of
// "../../etc" would relocate the whole per-session sandbox off-disk). Same
// guard, same shape, as looms.ts's loomDir and ultra/journal.ts's runDir.
// SDK session ids are UUID-shaped and satisfy it.
export const sessionDir = (sessionId: string): string => {
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    throw new Error(`invalid session id: ${JSON.stringify(sessionId)}`);
  }
  const base = sessionsDir();
  const dir = path.join(base, sessionId);
  const withSep = base.endsWith(path.sep) ? base : base + path.sep;
  if (!dir.startsWith(withSep)) {
    throw new Error(`invalid session id: ${JSON.stringify(sessionId)}`);
  }
  return dir;
};

// --- the session lifetime of THE lease (AD-16) ------------------------------
// Four thin compositions. Each one resolves the session root and hands it to
// the same function a loom root goes through, so the two lifetimes cannot
// drift: same `{pid, token, ts}` record, same `.runner-lease` filename, same
// atomic tmp+rename, same reclaim rule.

export const sessionLeaseFile = (sessionId: string): string => leaseFile(sessionDir(sessionId));

export function writeSessionLease(
  sessionId: string,
  lease: { pid: number; token: string },
  now: () => number = Date.now,
  io: LeaseFs = fs,
): RunnerLease {
  return writeLease(sessionDir(sessionId), lease, now, io);
}

export function heartbeatSessionLease(
  sessionId: string,
  now: () => number = Date.now,
  io: LeaseFs = fs,
): RunnerLease | null {
  return heartbeatLease(sessionDir(sessionId), now, io);
}

export function readSessionLease(sessionId: string, io: LeaseFs = fs): RunnerLease | null {
  return readLease(sessionDir(sessionId), io);
}

// The reclaim decision for a session, deferred WHOLE to the primitive's pure
// `leaseReclaim` — including its union, which structurally cannot say `done`
// (see runner/lease.ts's MOAT comment). Reading the lease is the only impure
// part; the decision itself is not made here.
export function sessionLeaseReclaim(
  sessionId: string,
  ttlMs: number,
  now: number,
  io: LeaseFs = fs,
): LeaseReclaim {
  return leaseReclaim(readSessionLease(sessionId, io), ttlMs, now);
}
