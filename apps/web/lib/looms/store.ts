import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * The loom store — v1 of the loom model (docs/loom-model-v1.md).
 *
 * A loom is born from a conversation and then DETACHES: it owns its origin
 * session and every thread session, and the ordinary sessions surface
 * subtracts them (see loomOwnedSessionIds). Contracts are bound to executable
 * verification tiers from the env contract, and verification runs against a
 * clean checkout of each thread's branch — never the agent's own worktree.
 *
 * Deliberately a plain JSON file under TELAR_HOME rather than an engine
 * table: the engine stays ignorant of looms. Nothing here may ever grow an
 * agent-callable accept — `acceptedAt` is stamped only by the accept route,
 * which only the UI calls.
 */

export type LoomState = "working" | "verifying" | "ready" | "accepted";

export interface ThreadVerification {
  tier: string;
  ok: boolean;
  at: number;
  detail?: string;
  /** The commit that was verified — evidence names its exact subject. */
  commit?: string;
}

export interface LoomThread {
  sessionId: string;
  slug: string;
  title: string;
  brief: string;
  /** Human-readable intent: what must be demonstrably true. */
  contract?: string;
  /** Executable binding: a verification tier from the project's env contract.
   *  Absent means the weaver found no fitting tier — visible, not hidden. */
  tier?: string;
  branch?: string;
  verification?: ThreadVerification;
}

export interface Loom {
  id: string;
  slug: string;
  title: string;
  objective: string;
  projectId: string;
  /** The conversation this loom was spun from. Owned: it leaves the ordinary
   *  sessions surface with the threads. */
  originSessionId?: string;
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

export function newLoom(init: Omit<Loom, "id" | "createdAt" | "slug"> & { slug?: string }): Loom {
  const slug = uniqueLoomSlug(init.slug ?? slugify(init.title), listLooms());
  return saveLoom({ ...init, slug, id: `loom_${randomUUID().replaceAll("-", "").slice(0, 12)}`, createdAt: Date.now() });
}

/** Names come from the work: "Hito 1 · Agosto" → "hito-1-agosto". */
export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "loom"
  );
}

/** A slug that collides with a live loom gets a numeric suffix rather than
 *  silently sharing branches with it. */
export function uniqueLoomSlug(base: string, existing: Loom[]): string {
  const taken = new Set(existing.map((l) => l.slug));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/**
 * Every session a loom owns — threads AND origin. The ordinary sessions
 * surface subtracts these; loom internals are reachable only through the room.
 */
export function loomOwnedSessionIds(): Set<string> {
  const ids = new Set<string>();
  for (const loom of listLooms()) {
    if (loom.originSessionId) ids.add(loom.originSessionId);
    for (const thread of loom.threads) ids.add(thread.sessionId);
  }
  return ids;
}

export function findLoomBySession(sessionId: string): Loom | undefined {
  return listLooms().find((l) => l.originSessionId === sessionId || l.threads.some((t) => t.sessionId === sessionId));
}

/** Derived, never stored: the state is what the evidence says it is. */
export function loomState(loom: Loom): LoomState {
  if (loom.acceptedAt) return "accepted";
  const verifications = loom.threads.map((t) => t.verification);
  if (verifications.every((v) => v?.ok)) return "ready";
  if (verifications.some((v) => v !== undefined)) return "verifying";
  return "working";
}
