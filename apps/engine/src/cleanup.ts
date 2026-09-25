/**
 * ══ THE AUTOMATIC CLEANUP — Settings → Storage's four switches ══
 *
 * Worktrees are RELEASED, never deleted outright: `releaseSessionWorktree`
 * removes the directory and keeps the branch and the conversation, and its
 * refusals (uncommitted changes, unpushed commits, a turn in flight, a live
 * process, a checkout Telar did not create) are the fixed rules here too. The
 * sweep calls it in strict mode, so "could not tell" is a refusal.
 *
 * Logs: only rotated files (`name.1`, `name.2.gz`, …) and per-session setup
 * logs of sessions whose checkout is gone, older than the window. The file a
 * process is writing to right now is never one of them.
 *
 * NOTHING WALKS A TREE ON A REQUEST PATH (#937). The only size ever taken is
 * `du -sk` of a checkout about to be released, in a child process, for the
 * "freed" line.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CleanupPolicy, CleanupReport, DEFAULT_CLEANUP_POLICY } from "@telar/engine-client";
import { atomicWrite } from "./atomic";

const DAY_MS = 24 * 60 * 60 * 1000;

export class CleanupStore {
  constructor(private readonly file: string) {}

  private read(): { policy: CleanupPolicy; last?: CleanupReport } {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as { policy?: unknown; last?: unknown };
      const policy = CleanupPolicy.safeParse(raw.policy);
      const last = CleanupReport.safeParse(raw.last);
      return { policy: policy.success ? policy.data : { ...DEFAULT_CLEANUP_POLICY }, ...(last.success ? { last: last.data } : {}) };
    } catch {
      return { policy: { ...DEFAULT_CLEANUP_POLICY } };
    }
  }

  policy(): CleanupPolicy {
    return this.read().policy;
  }

  last(): CleanupReport | undefined {
    return this.read().last;
  }

  /** Validates a patch; `undefined` when it names nothing legal. */
  setPolicy(patch: unknown): CleanupPolicy | undefined {
    const next = CleanupPolicy.safeParse({ ...this.policy(), ...(patch && typeof patch === "object" ? patch : {}) });
    if (!next.success) return undefined;
    atomicWrite(this.file, { version: 1, ...this.read(), policy: next.data });
    return next.data;
  }

  record(report: CleanupReport): void {
    atomicWrite(this.file, { version: 1, ...this.read(), last: report });
  }
}

export type CleanupCandidate = {
  sessionId: string;
  archived: boolean;
  released: boolean;
  /** When anything last happened in the session. */
  lastActiveAt: number;
};

/** Which sessions' checkouts the switches ask for, before the git proofs. Pure. */
export function planWorktreeCleanup(
  sessions: readonly CleanupCandidate[],
  policy: CleanupPolicy,
  now: number,
): Array<{ sessionId: string; reason: "archived" | "inactive" | "unchanged" }> {
  const plan: Array<{ sessionId: string; reason: "archived" | "inactive" | "unchanged" }> = [];
  for (const session of sessions) {
    if (session.released) continue;
    if (session.archived) {
      if (policy.archived) plan.push({ sessionId: session.sessionId, reason: "archived" });
      continue;
    }
    if (policy.inactiveDays !== null && now - session.lastActiveAt >= policy.inactiveDays * DAY_MS) {
      plan.push({ sessionId: session.sessionId, reason: "inactive" });
    } else if (policy.unchanged) {
      plan.push({ sessionId: session.sessionId, reason: "unchanged" });
    }
  }
  return plan;
}

/** A rotated generation: `worker.jsonl.1`, `engine.log.2.gz`, `x.log.old`. */
export function isRotated(name: string): boolean {
  return /\.(\d+|old)(\.gz)?$/.test(name);
}

/**
 * Delete the old logs: rotated files under `logDirectories`, and each given
 * setup log, when older than `days`. Returns how many went and their bytes.
 */
export async function sweepLogs(input: {
  logDirectories: readonly string[];
  setupLogs: readonly string[];
  days: number;
  now: number;
}): Promise<{ count: number; bytes: number }> {
  let count = 0;
  let bytes = 0;
  const cutoff = input.now - input.days * DAY_MS;
  const candidates: string[] = [...input.setupLogs];
  for (const directory of input.logDirectories) {
    let names: string[];
    try {
      names = await fs.promises.readdir(directory);
    } catch {
      continue;
    }
    for (const name of names) if (isRotated(name)) candidates.push(path.join(directory, name));
  }
  for (const file of candidates) {
    try {
      const stat = await fs.promises.lstat(file);
      if (!stat.isFile() || stat.mtimeMs > cutoff) continue;
      await fs.promises.rm(file, { force: true });
      count += 1;
      bytes += stat.size;
    } catch {
      // Gone already, or not ours to read: nothing to count.
    }
  }
  return { count, bytes };
}

/** `du -sk` in a child process; 0 when it cannot answer. Never walks in-process. */
export function diskUsage(target: string): Promise<number> {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      resolve(0);
      return;
    }
    let out = "";
    let child;
    try {
      child = spawn("du", ["-sk", target], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(0);
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 5 * 60 * 1000);
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.on("error", () => {
      clearTimeout(timer);
      resolve(0);
    });
    child.on("close", () => {
      clearTimeout(timer);
      const kb = Number(out.trim().split(/\s+/)[0]);
      resolve(Number.isFinite(kb) ? kb * 1024 : 0);
    });
  });
}
