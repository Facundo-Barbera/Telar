import fs from "node:fs";
import path from "node:path";
import type { AsyncGitRunner } from "../../platform/git/runner";

const DEPENDENCY_DIRS = new Set(["node_modules", ".venv"]);
const BUILD_OUTPUT_DIRS = new Set([".next", "dist", ".turbo"]);
const SKIP_DIRS = new Set([".git", ...DEPENDENCY_DIRS, ...BUILD_OUTPUT_DIRS]);
const MAX_DEPTH = 4;

function find(root: string, names: Set<string>): string[] {
  const found: string[] = [];
  const walk = (relative: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(relative, entry.name);
      if (names.has(entry.name)) found.push(child);
      else if (depth < MAX_DEPTH && !SKIP_DIRS.has(entry.name)) walk(child, depth + 1);
    }
  };
  walk("", 0);
  return found;
}

function inside(root: string, target: string): string | undefined {
  const relative = path.relative(root, target);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : undefined;
}

// A workspace package links back into the checkout; in the worktree it must resolve to the worktree's own copy.
function linkTarget(checkout: string, worktree: string, source: string): string {
  if (!fs.lstatSync(source).isSymbolicLink()) return source;
  let real: string;
  try {
    real = fs.realpathSync(source);
  } catch {
    return source;
  }
  const relative = inside(fs.realpathSync(checkout), real);
  return relative && !relative.split(path.sep).includes("node_modules") ? path.join(worktree, relative) : source;
}

function linkEntries(checkout: string, worktree: string, from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const destination = path.join(to, entry.name);
    if (fs.existsSync(destination)) continue;
    if (entry.name.startsWith("@") && entry.isDirectory()) linkEntries(checkout, worktree, source, destination);
    else fs.symlinkSync(linkTarget(checkout, worktree, source), destination);
  }
}

/**
 * Gives a new worktree the checkout's node_modules and .venv directories. Each becomes a real
 * directory of links, so a `node_modules/` ignore rule still matches it; returns what it linked.
 */
export function shareDependencies(checkout: string, worktree: string): string[] {
  const shared: string[] = [];
  for (const relative of find(checkout, DEPENDENCY_DIRS)) {
    const destination = path.join(worktree, relative);
    if (!fs.existsSync(path.dirname(destination)) || fs.existsSync(destination)) continue;
    try {
      linkEntries(checkout, worktree, path.join(checkout, relative), destination);
      shared.push(relative);
    } catch {
      // Best-effort: a half-linked directory is still one `bun install` away from whole.
    }
  }
  return shared;
}

/** Deletes the worktree's ignored .next, dist and .turbo directories; a tracked one stays. */
export async function pruneBuildOutputs(git: AsyncGitRunner, worktree: string): Promise<string[]> {
  if (!fs.existsSync(worktree)) return [];
  const candidates = find(worktree, BUILD_OUTPUT_DIRS);
  if (candidates.length === 0) return [];
  const ignored = await git(worktree, ["check-ignore", "--", ...candidates]);
  if (ignored.timedOut || (ignored.status !== 0 && ignored.status !== 1)) return [];
  const pruned = ignored.stdout.split("\n").filter((line) => candidates.includes(line));
  for (const relative of pruned) fs.rmSync(path.join(worktree, relative), { recursive: true, force: true });
  return pruned;
}
