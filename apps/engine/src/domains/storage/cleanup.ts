import fs from "node:fs";
import path from "node:path";
import { CleanupPolicy, CleanupReport, DEFAULT_CLEANUP_POLICY } from "@telar/engine-client";
import { atomicWrite } from "../../platform/fs/atomic";
import { eachBounded, type VolumeGate } from "../../platform/fs/volume-gate";

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

type CleanupReason = "archived" | "inactive" | "settled" | "unchanged";

export type CleanupCandidate = {
  sessionId: string;
  path: string;
  archived: boolean;
  released: boolean;
  lastActiveAt: number;
  settledAt?: number;
};

export type PlannedRelease = { sessionId: string; path: string; reason: CleanupReason };

export function planWorktreeCleanup(sessions: readonly CleanupCandidate[], policy: CleanupPolicy, now: number): PlannedRelease[] {
  const plan: PlannedRelease[] = [];
  for (const session of sessions) {
    if (session.released) continue;
    const planned = (reason: CleanupReason) => plan.push({ sessionId: session.sessionId, path: session.path, reason });
    if (session.archived) {
      if (policy.archived) planned("archived");
      continue;
    }
    if (policy.inactiveDays !== null && now - session.lastActiveAt >= policy.inactiveDays * DAY_MS) planned("inactive");
    else if (policy.settledDays !== null && session.settledAt !== undefined && now - session.settledAt >= policy.settledDays * DAY_MS) planned("settled");
    else if (policy.unchanged) planned("unchanged");
  }
  return plan;
}

export type SweepOutcome = "released" | "skipped" | "ignored";

type Busy = Set<string> | undefined;

export type SweepDeps = {
  release(item: PlannedRelease, processes: () => Promise<Busy>): Promise<SweepOutcome>;
  processes(checkouts: readonly string[]): Promise<Busy>;
  sizeOf(target: string): number | undefined;
  gate: VolumeGate;
  tried: Map<string, number>;
  limit?: number;
  concurrency?: number;
  timeoutMs?: number;
};

const SWEEP_TIMEOUT_MS = 60_000;
const SWEEP_LIMIT = 8;

/** Releases at most `limit` of the plan, least recently tried first (`tried` is the caller's, kept across sweeps); a volume that is missing or stops answering is skipped whole. */
export async function sweepCheckouts(plan: readonly PlannedRelease[], deps: SweepDeps): Promise<{ released: number; skipped: number; freedBytes: number }> {
  const tally = { released: 0, skipped: 0, freedBytes: 0 };
  const planned = new Set(plan.map((item) => item.sessionId));
  for (const sessionId of deps.tried.keys()) if (!planned.has(sessionId)) deps.tried.delete(sessionId);
  const lastTry = (item: PlannedRelease) => deps.tried.get(item.sessionId) ?? 0;
  const batch = [...plan].sort((a, b) => lastTry(a) - lastTry(b)).slice(0, deps.limit ?? SWEEP_LIMIT);
  const sweep = Math.max(0, ...deps.tried.values()) + 1;
  for (const item of batch) deps.tried.set(item.sessionId, sweep);
  let busy: Promise<Busy> | undefined;
  const processes = () => (busy ??= deps.processes(batch.map((item) => item.path)));
  await deps.gate.admit(batch.map((item) => item.path));
  await eachBounded(batch, deps.concurrency ?? 2, async (item) => {
    const bytes = deps.sizeOf(item.path);
    const outcome = await deps.gate.run(item.path, () => deps.release(item, processes), deps.timeoutMs ?? SWEEP_TIMEOUT_MS);
    if (outcome === "released") {
      tally.released += 1;
      tally.freedBytes += bytes ?? 0;
    } else if (outcome !== "ignored") tally.skipped += 1;
  });
  return tally;
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
