import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * The loom store — v0 of the front for the loom model.
 *
 * A loom is an objective decomposed into threads (worktree sessions), each of
 * which must pass verification before a HUMAN accepts the loom. Deliberately a
 * plain JSON file under TELAR_HOME rather than an engine table: this surface
 * exists to make the loom lifecycle visible and to hold the accept moat while
 * the real wiring into the engine lands. Nothing here may ever grow an
 * agent-callable accept — `acceptedAt` is stamped only by the accept route,
 * which only the UI calls.
 */

export type LoomState = "working" | "verifying" | "ready" | "accepted";

export interface ThreadVerification {
  tier: string;
  ok: boolean;
  at: number;
  detail?: string;
}

export interface LoomThread {
  sessionId: string;
  title: string;
  brief: string;
  /** The thread's verification contract — what must be demonstrably true for
   *  this thread to be done, in the weaver's (or human's) own words. */
  contract?: string;
  verification?: ThreadVerification;
}

export interface Loom {
  id: string;
  title: string;
  objective: string;
  projectId: string;
  threads: LoomThread[];
  createdAt: number;
  /** Human sign-off. There is no code path that sets this from an agent. */
  acceptedAt?: number;
}

interface LoomsFile {
  version: 1;
  looms: Loom[];
}

function storePath(): string {
  const home = process.env.TELAR_HOME ?? join(homedir(), ".telar");
  return join(home, "looms", "looms.json");
}

function readAll(): LoomsFile {
  const path = storePath();
  if (!existsSync(path)) return { version: 1, looms: [] };
  return JSON.parse(readFileSync(path, "utf8")) as LoomsFile;
}

function writeAll(file: LoomsFile): void {
  const path = storePath();
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(file, null, 2));
  renameSync(tmp, path);
}

export function listLooms(): Loom[] {
  return readAll().looms;
}

export function getLoom(id: string): Loom | undefined {
  return readAll().looms.find((l) => l.id === id);
}

export function saveLoom(loom: Loom): Loom {
  const file = readAll();
  const index = file.looms.findIndex((l) => l.id === loom.id);
  if (index >= 0) file.looms[index] = loom;
  else file.looms.push(loom);
  writeAll(file);
  return loom;
}

export function newLoom(init: Omit<Loom, "id" | "createdAt">): Loom {
  return saveLoom({ ...init, id: `loom_${randomUUID().replaceAll("-", "").slice(0, 12)}`, createdAt: Date.now() });
}

/** Derived, never stored: the state is what the evidence says it is. */
export function loomState(loom: Loom): LoomState {
  if (loom.acceptedAt) return "accepted";
  const verifications = loom.threads.map((t) => t.verification);
  if (verifications.every((v) => v?.ok)) return "ready";
  if (verifications.some((v) => v !== undefined)) return "verifying";
  return "working";
}
