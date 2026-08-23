import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * The loom store — v2 of the loom model (docs/loom-model-v1.md + the method
 * contract, docs/method-contract-v0.md).
 *
 * v2 adds the pieces the paper test demanded:
 *  - PHASES with GATES. A loom walks a method's phase graph; a phase whose
 *    gate is `human` parks the loom in `waiting` until it is cleared in the
 *    room. Approval stopped being creation-time — threads exist as PLANS
 *    (sessionId absent) until the execute gate clears and they spawn.
 *  - THE LOOM DOCUMENT. Each loom owns a directory (spec.md, journal.md)
 *    under TELAR_HOME — the conductor's whole memory. The conductor is
 *    episodic: it boots from these files, moves once, writes back, dies.
 *    Long-lived state, never long-lived context.
 *
 * Unchanged and non-negotiable: `acceptedAt` is stamped only by the accept
 * route, which only the UI calls. No agent-callable accept exists.
 */

export type LoomState = "waiting" | "working" | "verifying" | "ready" | "accepted";

export type PhaseStatus = "pending" | "running" | "waiting" | "done";

export interface LoomPhase {
  id: string;
  kind: "plan" | "execute";
  /** `human` parks the loom until the room clears it; `none` advances alone. */
  gate: "human" | "none";
  status: PhaseStatus;
  at?: number;
}

export interface ThreadVerification {
  tier: string;
  ok: boolean;
  at: number;
  detail?: string;
  /** The commit that was verified — evidence names its exact subject. */
  commit?: string;
}

export interface LoomThread {
  /** ABSENT UNTIL SPAWNED. A thread is a plan first; the execute gate
   *  clearing is what turns it into a session. */
  sessionId?: string;
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
  /** Which method pack produced this loom's phase graph. */
  method?: string;
  phases?: LoomPhase[];
  /** The conversation this loom was spun from. Owned: it leaves the ordinary
   *  sessions surface with the threads. */
  originSessionId?: string;
  threads: LoomThread[];
  /** An escalation from the conductor — something it judged a human should
   *  see. Cleared by the room. */
  attention?: string;
  /** Last conductor episode, for throttling. */
  conductedAt?: number;
  createdAt: number;
  /** Human sign-off. There is no code path that sets this from an agent. */
  acceptedAt?: number;
}

interface LoomsFile {
  version: 1;
  looms: Loom[];
}

function telarHome(): string {
  return process.env.TELAR_HOME ?? join(homedir(), ".telar");
}

function storePath(): string {
  return join(telarHome(), "looms", "looms.json");
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

/** A draft loom (nothing spawned) can be discarded; one with sessions cannot
 *  — those sessions are work, and work is archived through the engine, not
 *  vanished by a store delete. */
export function deleteDraftLoom(id: string): boolean {
  const file = readAll();
  const loom = file.looms.find((l) => l.id === id);
  if (!loom || loom.threads.some((t) => t.sessionId)) return false;
  file.looms = file.looms.filter((l) => l.id !== id);
  writeAll(file);
  rmSync(loomDir(id), { recursive: true, force: true });
  return true;
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
    for (const thread of loom.threads) if (thread.sessionId) ids.add(thread.sessionId);
  }
  return ids;
}

export function findLoomBySession(sessionId: string): Loom | undefined {
  return listLooms().find((l) => l.originSessionId === sessionId || l.threads.some((t) => t.sessionId === sessionId));
}

/**
 * Derived, never stored: the state is what the evidence says it is.
 *
 * `waiting` is v2's addition — a gate is open for a human. It outranks
 * everything except acceptance, because a parked loom's one true fact is
 * that YOU are what it is waiting for.
 */
export function loomState(loom: Loom): LoomState {
  if (loom.acceptedAt) return "accepted";
  if (loom.phases?.some((p) => p.status === "waiting")) return "waiting";
  const spawned = loom.threads.filter((t) => t.sessionId);
  if (spawned.length === 0) return "waiting";
  const verifications = spawned.map((t) => t.verification);
  if (verifications.every((v) => v?.ok)) return "ready";
  if (verifications.some((v) => v !== undefined)) return "verifying";
  return "working";
}

/* ------------------------------------------------------------------ *
 * The loom document — the conductor's memory, on disk and legible.
 * ------------------------------------------------------------------ */

export function loomDir(id: string): string {
  return join(telarHome(), "looms", id);
}

export function writeSpec(id: string, markdown: string): void {
  mkdirSync(loomDir(id), { recursive: true });
  writeFileSync(join(loomDir(id), "spec.md"), markdown);
}

export function readSpec(id: string): string | null {
  const path = join(loomDir(id), "spec.md");
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** Append-only. Every machine event and every conductor decision lands here,
 *  timestamped — the audit trail the episodic conductor reboots from. */
export function appendJournal(id: string, actor: string, entry: string): void {
  mkdirSync(loomDir(id), { recursive: true });
  const line = `- ${new Date().toISOString()} **${actor}**: ${entry.replaceAll("\n", " ").slice(0, 500)}\n`;
  appendFileSync(join(loomDir(id), "journal.md"), line);
}

export function readJournal(id: string, tailLines = 40): string {
  const path = join(loomDir(id), "journal.md");
  if (!existsSync(path)) return "";
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  return lines.slice(-tailLines).join("\n");
}
