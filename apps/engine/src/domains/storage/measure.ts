import fs from "node:fs";
import path from "node:path";
import type { StorageCategory, StorageEntry, StorageReport } from "@telar/engine-client";
import { detectCacheDedup } from "./package-caches";

export const DIRECTORY_CATEGORIES: Readonly<Record<string, StorageCategory>> = {
  sessions: "sessions",
  python: "python",
  "browser-profiles": "browser-profiles",
  notes: "notes",
  dictation: "dictation",
  run: "run",
  diagnostics: "diagnostics",
  retired: "other",
  orientation: "settings",
};

function isJournalFile(name: string): boolean {
  return name === "execution.sqlite" || name.startsWith("execution.sqlite-") || name === "execution-store.json";
}

function categoryOfFile(name: string): StorageCategory {
  if (isJournalFile(name)) return "journal";
  if (name === "usage-scan-cache.json" || name === "usage-model-rates.json") return "usage";
  if (name.endsWith(".json") || name.includes(".json.bak") || name === "engine.lock") return "settings";
  return "other";
}

type Target = { path: string; kind: "directory" | "file" };

type Walk = { bytes: number; partial: boolean };

const STAT_BATCH = 64;

function firstLink(stat: fs.Stats, seen: Set<string>): boolean {
  if (stat.nlink <= 1) return true;
  const inode = `${stat.dev}:${stat.ino}`;
  if (seen.has(inode)) return false;
  seen.add(inode);
  return true;
}

export function bytesOf(stat: Pick<fs.Stats, "blocks" | "size">): number {
  const allocated = stat.blocks * 512;
  return allocated > 0 || stat.size === 0 ? allocated : stat.size;
}

async function walk(root: string, seen: Set<string>): Promise<Walk> {
  let bytes = 0;
  let partial = false;

  let rootStat: fs.Stats;
  try {
    rootStat = await fs.promises.lstat(root);
  } catch {
    return { bytes: 0, partial: false };
  }
  if (!rootStat.isDirectory()) return { bytes: bytesOf(rootStat), partial: false };
  bytes += bytesOf(rootStat);

  const frontier: string[] = [root];
  while (frontier.length > 0) {
    const dir = frontier.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      partial = true;
      continue;
    }
    for (let at = 0; at < entries.length; at += STAT_BATCH) {
      const batch = entries.slice(at, at + STAT_BATCH);
      const stats = await Promise.all(
        batch.map(async (entry) => {
          const target = path.join(dir, entry.name);
          try {
            return { target, stat: await fs.promises.lstat(target) };
          } catch {
            return { target, stat: undefined };
          }
        }),
      );
      for (const { target, stat } of stats) {
        if (!stat) {
          partial = true;
          continue;
        }
        if (stat.isDirectory()) {
          frontier.push(target);
          bytes += bytesOf(stat);
          continue;
        }
        if (firstLink(stat, seen)) bytes += bytesOf(stat);
      }
    }
  }
  return { bytes, partial };
}

export async function measureDirectory(target: string): Promise<{ bytes: number; partial: boolean }> {
  return walk(target, new Set<string>());
}

function targetOf(category: StorageCategory, root: string): Target {
  if (category === "journal") {
    const database = path.join(root, "execution.sqlite");
    return fs.existsSync(database) ? { path: database, kind: "file" } : { path: root, kind: "directory" };
  }
  const directory = DIRECTORY_CATEGORIES[category] === category ? category : undefined;
  return { path: directory ? path.join(root, directory) : root, kind: "directory" };
}

type StorageInput = {
  root: string;
  worktreesRoot: string;
  alsoWorktrees?: readonly string[];
  now?: number;
};

export function checkoutRootsOf(input: Pick<StorageInput, "worktreesRoot" | "alsoWorktrees">): string[] {
  const worktrees = path.resolve(input.worktreesRoot);
  return [worktrees, ...(input.alsoWorktrees ?? []).map((extra) => path.resolve(extra)).filter((extra) => extra !== worktrees)];
}

export type CheckoutFigure = {
  bytes: number;
  partial: boolean;
  measuring: boolean;
  measured?: number;
  of?: number;
};

export async function measureStorage(input: StorageInput): Promise<StorageReport> {
  const started = Date.now();
  const seen = new Set<string>();
  let bytes = 0;
  let partial = false;
  for (const target of checkoutRootsOf(input)) {
    const checkouts = await walk(target, seen);
    bytes += checkouts.bytes;
    partial ||= checkouts.partial;
  }
  const store = await measureStore(input, seen);
  return { ...withCheckouts(store, { bytes, partial, measuring: false }, input.worktreesRoot), tookMs: Date.now() - started };
}

export async function measureStore(input: StorageInput, seen = new Set<string>()): Promise<StorageReport> {
  const started = Date.now();
  const root = path.resolve(input.root);
  const worktrees = path.resolve(input.worktreesRoot);
  const bytes = new Map<StorageCategory, number>();
  let partial = false;

  const add = (category: StorageCategory, amount: number) => bytes.set(category, (bytes.get(category) ?? 0) + amount);

  let children: fs.Dirent[] = [];
  try {
    children = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    partial = true;
  }
  const checkoutRoots = new Set(checkoutRootsOf(input));
  for (const child of children) {
    const target = path.join(root, child.name);
    if (checkoutRoots.has(target)) continue;
    if (child.isDirectory()) {
      const measured = await walk(target, seen);
      add(DIRECTORY_CATEGORIES[child.name] ?? "other", measured.bytes);
      partial ||= measured.partial;
      continue;
    }
    try {
      const stat = await fs.promises.lstat(target);
      if (firstLink(stat, seen)) add(categoryOfFile(child.name), bytesOf(stat));
    } catch {
      partial = true;
    }
  }

  const entries: StorageEntry[] = [...bytes.entries()]
    .filter(([, amount]) => amount > 0)
    .map(([category, amount]) => {
      const target = targetOf(category, root);
      return { category, bytes: amount, path: target.path, kind: target.kind };
    })
    .sort((left, right) => right.bytes - left.bytes);

  const caches = detectCacheDedup(worktrees)
    .filter((verdict): verdict is typeof verdict & { dedup: "different-device" | "unreachable" } => verdict.dedup !== "same-device")
    .map(({ name, path: cache, dedup }) => ({ name, path: cache, dedup }));

  return {
    root,
    total: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    entries,
    measuredAt: input.now ?? Date.now(),
    tookMs: Date.now() - started,
    partial,
    ...(caches.length > 0 ? { caches } : {}),
  };
}

export function withCheckouts(report: StorageReport, checkouts: CheckoutFigure, worktreesRoot: string): StorageReport {
  const entries = report.entries.filter((entry) => entry.category !== "worktrees");
  if (checkouts.bytes > 0 || checkouts.measuring) {
    const status = checkouts.measuring ? "measuring" : checkouts.partial ? "partial" : undefined;
    entries.push({
      category: "worktrees",
      bytes: checkouts.bytes,
      path: path.resolve(worktreesRoot),
      kind: "directory",
      ...(status ? { status } : {}),
      ...(checkouts.measuring && checkouts.of !== undefined ? { progress: { measured: checkouts.measured ?? 0, of: checkouts.of } } : {}),
    });
  }
  entries.sort((left, right) => right.bytes - left.bytes);
  return {
    ...report,
    total: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    entries,
    partial: report.partial || checkouts.partial,
  };
}
