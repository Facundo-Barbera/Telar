// M3 — the one shared git/VCS module. Promotes the worktree primitives that
// used to be private to build-fanout.ts into a single injectable, unit-tested
// place, and adds the per-loom-isolation + consolidation primitives (base-SHA
// pinning, a serialized worktree mutex, a persistent review branch, the
// thread-fold-onto-branch copy, and a crash-orphan reaper).
//
// Every function takes an injectable GitRunner so tests drive real throwaway
// tmp git repos — never the telar repo or ~/.telar. `execFileSync` is blocking,
// so the mutex mostly guards async ORDERING (and makes the path correct if the
// runner is ever made async), but it also serializes the .git/worktrees/ index
// lock that N parallel `git worktree add/remove` calls would otherwise contend.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// An injectable git runner (docs/loom-model.md §A — landing the work): given
// the project root and argv, run git and report its exit status + output. The
// default shells out; tests swap in a fake so no real git process runs and no
// working tree is touched. The runner owns pointing git at `root` (`git -C`).
export type GitRunResult = { status: number; stdout: string; stderr: string };
export type GitRunner = (root: string, args: string[]) => GitRunResult;

export const defaultGitRunner: GitRunner = (root, args) => {
  try {
    const stdout = execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: unknown; stderr?: unknown };
    return {
      status: typeof e.status === "number" ? e.status : 1,
      stdout: e.stdout ? String(e.stdout) : "",
      stderr: e.stderr ? String(e.stderr) : String(err),
    };
  }
};

// The flag: per-loom worktree isolation is opt-in (manifest.isolateWorktrees,
// default false) OR forced on for a live-validation run via the env override,
// so flag-off every code path is byte-identical to pre-M3.
export function isolationEnabled(manifest: { isolateWorktrees?: boolean }): boolean {
  return manifest.isolateWorktrees === true || process.env.TELAR_ISOLATE_WORKTREES === "1";
}

// --- path helpers (shared with build-fanout.ts's overlap check) ------------

// The literal, non-glob portion of a path pattern — everything before the
// first glob metacharacter.
export function globBase(p: string): string {
  const idx = p.search(/[*?[]/);
  return idx === -1 ? p : p.slice(0, idx);
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

// --- the worktree mutex ----------------------------------------------------

// A module-level async mutex. All `git worktree add/remove`, branch-create, and
// fold-commit sequences chain through here so parallel threads never contend on
// the .git/worktrees/ index lock. A rejection never breaks the chain for the
// next waiter.
let chain: Promise<unknown> = Promise.resolve();
export function withWorktreeLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = chain.then(() => fn());
  chain = run.catch(() => {});
  return run;
}

// --- worktree lifecycle ----------------------------------------------------

// Per-call incrementing counter for worktree-directory uniqueness — no
// Date.now/Math.random, so tests stay deterministic.
let worktreeCounter = 0;

function sanitizeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_");
}

// `git worktree add [--detach] <os.tmpdir()/telar-wt-<id>-<counter>> <ref>`.
// Detached by default (a base SHA); pass { detach: false } to check a branch
// OUT into the worktree (the transient fold worktree). Throws on failure so the
// caller's Promise.allSettled / try-catch sees it, mirroring the pre-M3
// execFileSync behavior.
export function addWorktree(
  git: GitRunner,
  repoRoot: string,
  ref: string,
  id: string,
  opts?: { detach?: boolean },
): string {
  worktreeCounter++;
  const wt = path.join(os.tmpdir(), `telar-wt-${sanitizeId(id)}-${worktreeCounter}`);
  const detach = opts?.detach !== false;
  const args = detach ? ["worktree", "add", "--detach", wt, ref] : ["worktree", "add", wt, ref];
  const r = git(repoRoot, args);
  if (r.status !== 0) {
    throw new Error(`git worktree add failed: ${r.stderr.trim() || r.stdout.trim()}`);
  }
  return wt;
}

// Best-effort `git worktree remove --force`, then `git worktree prune`. A
// failed remove must never break the caller (a leaked *directory* is bounded
// under os.tmpdir(), never inside the user's repo), and the trailing prune
// clears a registration a failed remove would otherwise leak. Double-remove is
// a no-op.
export function removeWorktree(git: GitRunner, repoRoot: string, wt: string): void {
  try {
    git(repoRoot, ["worktree", "remove", "--force", wt]);
  } catch {
    // best-effort — the default runner never throws, this guards a fake that might
  }
  try {
    git(repoRoot, ["worktree", "prune"]);
  } catch {}
}

// Parses `git status --porcelain` for the SOURCE worktree's changed files,
// copying only those under one of `allowedPaths` into `destRoot`. Anything else
// the builder touched is recorded as "stray" and deliberately NOT copied —
// this keeps a fold conflict-free by construction. The destination is a param
// (need not equal the source's repo root) so the same copy serves both the
// build fan-out (dest = shared root) and the thread fold (dest = a transient
// branch worktree).
export function mergeDisjoint(
  git: GitRunner,
  srcWt: string,
  destRoot: string,
  allowedPaths: string[],
): { merged: string[]; stray: string[] } {
  // core.quotepath=false: stop git from octal-escaping non-ASCII filenames in
  // --porcelain output (without it "café.txt" comes back as "caf\303\251.txt"
  // and the path.join below points at a nonexistent path, throwing ENOENT).
  const raw = git(srcWt, ["-c", "core.quotepath=false", "status", "--porcelain"]).stdout;
  const merged: string[] = [];
  const stray: string[] = [];

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const status = line.slice(0, 2);
    let filePath = line.slice(3);
    if (status.includes("R")) {
      // rename: "old -> new" — merge the destination.
      const parts = filePath.split(" -> ");
      filePath = parts[parts.length - 1]!;
    }
    // Strip possible git quoting around paths with special characters.
    filePath = filePath.replace(/^"|"$/g, "");

    const fp = normalizePath(filePath);
    const isAllowed = allowedPaths.some((p) => {
      const base = normalizePath(globBase(p));
      return base === "" || fp === base || fp.startsWith(base + "/");
    });

    if (isAllowed) {
      const src = path.join(srcWt, filePath);
      const dest = path.join(destRoot, filePath);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      merged.push(filePath);
    } else {
      stray.push(filePath);
    }
  }

  return { merged, stray };
}

// --- base ref + consolidation branch --------------------------------------

// Resolve the pinned base SHA once from the manifest's baseBranch at root
// start. Returns null on a non-git root / missing ref (isolation then no-ops
// and falls back to the shared root — safe).
export function resolveBaseSha(git: GitRunner, repoRoot: string, baseBranch: string): string | null {
  const r = git(repoRoot, ["rev-parse", "--verify", baseBranch]);
  const sha = r.stdout.trim();
  return r.status === 0 && sha ? sha : null;
}

// `git branch <branch> <baseSha>` — idempotent: if the branch already exists,
// leave it untouched. No checkout in the shared root.
export function createConsolidationBranch(git: GitRunner, repoRoot: string, branch: string, baseSha: string): void {
  const exists = git(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (exists.status === 0 && exists.stdout.trim()) return;
  const r = git(repoRoot, ["branch", branch, baseSha]);
  if (r.status !== 0) {
    throw new Error(`git branch ${branch} failed: ${r.stderr.trim() || r.stdout.trim()}`);
  }
}

// Fold a thread's changed+allowed files onto the persistent review branch, via
// a TRANSIENT worktree checked out on that branch: mergeDisjoint copies the
// thread's diff in, then `git add -A && git commit` advances the branch, then
// the transient worktree is removed. The branch persists; the transient
// worktree does not. Serialized through the worktree mutex so concurrent child
// completions can't race the branch or the index lock.
export function foldThreadIntoBranch(
  git: GitRunner,
  repoRoot: string,
  branch: string,
  threadWorktree: string,
  allowedPaths: string[],
  message: string,
  baseSha?: string,
): Promise<{ merged: string[]; stray: string[]; collisions: string[] }> {
  return withWorktreeLock(() => {
    const transient = addWorktree(git, repoRoot, branch, `fold-${branch}`, { detach: false });
    try {
      // Files a PRIOR thread already changed on the branch (vs the pinned base),
      // captured before this thread's copy overwrites anything. Weave subgoals
      // carry no per-thread path scope, so two threads CAN touch the same file;
      // the copy-based fold would otherwise silently last-write-wins. We flag
      // that collision instead of pretending the gather was clean. Needs a base
      // to diff against; without one, collision detection is skipped (best-effort).
      const priorChanged = baseSha
        ? new Set(
            git(transient, ["diff", "--name-only", baseSha, "--"]).stdout
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean),
          )
        : null;

      const res = mergeDisjoint(git, threadWorktree, transient, allowedPaths);
      const add = git(transient, ["add", "-A"]);
      if (add.status !== 0) {
        throw new Error(`git add failed during fold: ${add.stderr.trim()}`);
      }
      // Only commit if the copy actually staged something — an all-stray thread
      // (nothing in scope) leaves the branch untouched rather than adding an
      // empty commit.
      const staged = git(transient, ["status", "--porcelain"]).stdout.trim();

      // A genuine same-file collision = a file THIS thread changes vs the branch
      // (staged diff) that a PRIOR thread had already changed vs base. Two
      // threads that produced byte-identical content stage nothing → no false
      // collision.
      let collisions: string[] = [];
      if (priorChanged && priorChanged.size > 0 && staged) {
        const thisChanged = git(transient, ["diff", "--cached", "--name-only"]).stdout
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        collisions = thisChanged.filter((f) => priorChanged.has(f));
      }

      if (staged) {
        const commit = git(transient, ["commit", "--no-verify", "-m", message]);
        if (commit.status !== 0) {
          throw new Error(`git commit failed during fold: ${commit.stderr.trim() || commit.stdout.trim()}`);
        }
      }
      return { ...res, collisions };
    } finally {
      removeWorktree(git, repoRoot, transient);
    }
  });
}

// --- crash-orphan reaper ---------------------------------------------------

// Belt-and-suspenders for a killed process that couldn't run its finally:
// `git worktree prune`, then force-remove any registered worktree whose dir is
// a telar-wt-* checkout AND not in the live set. Consolidation BRANCHES are
// intentionally left alone (a telar/<id> branch from a crashed run is harmless,
// possibly useful — branch GC is the human's call). Matches live worktrees by
// basename so a macOS /var vs /private/var realpath difference between the
// recorded path and git's registration never reaps a live checkout.
export function reapOrphanWorktrees(git: GitRunner, repoRoot: string, liveWorktreePaths: string[]): void {
  git(repoRoot, ["worktree", "prune"]);
  const list = git(repoRoot, ["worktree", "list", "--porcelain"]);
  if (list.status !== 0) return; // not a git repo / no worktrees — no-op
  const liveBasenames = new Set(liveWorktreePaths.map((p) => path.basename(p)));
  for (const line of list.stdout.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const wtPath = line.slice("worktree ".length).trim();
    const base = path.basename(wtPath);
    if (!base.startsWith("telar-wt-")) continue; // never touch the main worktree or a user's own
    if (liveBasenames.has(base)) continue; // an in-flight loom owns this one
    removeWorktree(git, repoRoot, wtPath);
  }
}
