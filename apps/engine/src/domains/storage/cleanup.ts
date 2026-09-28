import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CleanupPolicy, CleanupReport, DEFAULT_CLEANUP_POLICY } from "@telar/engine-client";
import { atomicWrite } from "../../platform/fs/atomic";

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
  lastActiveAt: number;
};

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

export function isRotated(name: string): boolean {
  return /\.(\d+|old)(\.gz)?$/.test(name);
}

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
    }
  }
  return { count, bytes };
}

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
