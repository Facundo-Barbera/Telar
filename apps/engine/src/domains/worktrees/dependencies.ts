import fs from "node:fs/promises";
import path from "node:path";
import type { AsyncGitRunner } from "../../platform/git/runner";

const DEPENDENCY_DIRS = new Set(["node_modules", ".venv"]);
const BUILD_OUTPUT_DIRS = new Set([".next", "dist", ".turbo"]);
const SKIP_DIRS = new Set([".git", ...DEPENDENCY_DIRS, ...BUILD_OUTPUT_DIRS]);
const MAX_DEPTH = 4;
export const DEPENDENCY_LIMITS = { scannedEntries: 20_000, linksPerDirectory: 20_000 };

class OverLimit extends Error {}

const exists = (file: string) => fs.lstat(file).then(() => true, () => false);

async function find(root: string, names: Set<string>): Promise<string[]> {
  const found: string[] = [];
  let budget = DEPENDENCY_LIMITS.scannedEntries;
  const walk = async (relative: string, depth: number) => {
    let directory: import("node:fs").Dir;
    try {
      directory = await fs.opendir(path.join(root, relative));
    } catch {
      return;
    }
    const children: string[] = [];
    try {
      for await (const entry of directory) {
        if (--budget < 0) break;
        if (!entry.isDirectory()) continue;
        const child = path.join(relative, entry.name);
        if (names.has(entry.name)) found.push(child);
        else if (depth < MAX_DEPTH && !SKIP_DIRS.has(entry.name)) children.push(child);
      }
    } catch {
      return;
    }
    for (const child of children) if (budget > 0) await walk(child, depth + 1);
  };
  await walk("", 0);
  return found;
}

function inside(root: string, target: string): string | undefined {
  const relative = path.relative(root, target);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : undefined;
}

// A real directory of links keeps `node_modules/` ignore rules matching; workspace packages resolve to the worktree's copy.
async function linkTarget(realCheckout: string, worktree: string, source: string): Promise<string> {
  if (!(await fs.lstat(source)).isSymbolicLink()) return source;
  const real = await fs.realpath(source).catch(() => undefined);
  const relative = real && inside(realCheckout, real);
  return relative && !relative.split(path.sep).includes("node_modules") ? path.join(worktree, relative) : source;
}

type Link = { source: string; destination: string; directory: boolean };

async function planLinks(from: string, to: string, plan: Link[]): Promise<void> {
  for await (const entry of await fs.opendir(from)) {
    if (plan.length >= DEPENDENCY_LIMITS.linksPerDirectory) throw new OverLimit();
    const source = path.join(from, entry.name);
    const destination = path.join(to, entry.name);
    const scope = entry.name.startsWith("@") && entry.isDirectory();
    plan.push({ source, destination, directory: scope });
    if (scope) await planLinks(source, destination, plan);
  }
}

async function linkEntries(realCheckout: string, worktree: string, from: string, to: string): Promise<void> {
  const plan: Link[] = [];
  await planLinks(from, to, plan);
  await fs.mkdir(to, { recursive: true });
  for (const link of plan) {
    if (link.directory) await fs.mkdir(link.destination, { recursive: true });
    else if (!(await exists(link.destination))) await fs.symlink(await linkTarget(realCheckout, worktree, link.source), link.destination);
  }
}

export async function shareDependencies(checkout: string, worktree: string): Promise<string[]> {
  const shared: string[] = [];
  const realCheckout = await fs.realpath(checkout).catch(() => checkout);
  for (const relative of await find(checkout, DEPENDENCY_DIRS)) {
    const destination = path.join(worktree, relative);
    if (!(await exists(path.dirname(destination))) || (await exists(destination))) continue;
    try {
      await linkEntries(realCheckout, worktree, path.join(checkout, relative), destination);
    } catch {
      continue;
    }
    shared.push(relative);
  }
  return shared;
}

export async function pruneBuildOutputs(git: AsyncGitRunner, worktree: string): Promise<string[]> {
  if (!(await exists(worktree))) return [];
  const candidates = await find(worktree, BUILD_OUTPUT_DIRS);
  if (candidates.length === 0) return [];
  const ignored = await git(worktree, ["check-ignore", "--", ...candidates]);
  if (ignored.timedOut || (ignored.status !== 0 && ignored.status !== 1)) return [];
  const pruned = ignored.stdout.split("\n").filter((line) => candidates.includes(line));
  for (const relative of pruned) await fs.rm(path.join(worktree, relative), { recursive: true, force: true });
  return pruned;
}
