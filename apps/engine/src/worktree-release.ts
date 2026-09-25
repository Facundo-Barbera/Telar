/**
 * ══ RELEASING A SESSION'S CHECKOUT, AND GETTING IT BACK ══
 *
 * A released session keeps its conversation and its branch and loses only
 * the directory. The next message — or opening its files — re-cuts the
 * checkout at the same path from the same branch. That makes deleting a
 * worktree cheap to undo, which is what lets it happen automatically.
 *
 * WHAT IS NEVER RELEASED, checked here at the moment it would happen:
 *   - a checkout with uncommitted changes (or one git could not prove clean);
 *   - a branch with commits that are on no remote — the branch survives a
 *     release, but "unpushed" is the owner's line and it is kept literally;
 *   - a checkout a process has as its working directory (a run, a terminal);
 *   - a checkout outside Telar's worktrees root — somebody else's.
 * A turn in flight is the caller's check: only the store knows it.
 *
 * THE RE-CUT IS `git worktree add <path> <branch>` — never `-B`, which would
 * reset the branch to the old base and lose every commit the session made.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { lockSessionWorktree, WORKTREE_ADD_TIMEOUT_MS, WorktreeError, type AsyncGitRunner } from "./worktree";

export type ReleaseRefusal = "dirty" | "unpushed" | "process" | "not-telars" | "not-found";

function inside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * WHICH OF THESE CHECKOUTS HAVE A PROCESS IN THEM, by working directory.
 * `undefined` when the platform cannot say (Windows, no `lsof`) — "could not
 * tell" is not "nothing is running", and the caller decides what that costs.
 */
export async function checkoutsWithProcesses(
  checkouts: readonly string[],
  deps: { platform?: NodeJS.Platform; lsof?: () => Promise<string | undefined> } = {},
): Promise<Set<string> | undefined> {
  if ((deps.platform ?? process.platform) === "win32") return undefined;
  const listing = await (deps.lsof ?? readCwds)();
  if (listing === undefined) return undefined;
  const cwds = listing
    .split("\n")
    .filter((line) => line.startsWith("n"))
    .map((line) => path.resolve(line.slice(1)));
  const busy = new Set<string>();
  for (const checkout of checkouts) {
    const root = path.resolve(checkout);
    if (cwds.some((cwd) => cwd === root || inside(root, cwd))) busy.add(checkout);
  }
  return busy;
}

function readCwds(): Promise<string | undefined> {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn("lsof", ["-n", "-P", "-w", "-d", "cwd", "-F", "n"], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(undefined);
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.on("error", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    // lsof exits 1 when some process could not be read; the rest is still an answer.
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve(status === 0 || status === 1 ? out : undefined);
    });
  });
}

/**
 * Whether a checkout may go, and why not. `processes` is the answer of
 * `checkoutsWithProcesses` for this checkout: `true`, `false`, or `undefined`
 * when nobody could tell — which `strict` (the automatic sweep) refuses.
 */
export async function releaseRefusal(
  git: AsyncGitRunner,
  input: {
    projectRoot: string;
    worktreesRoots: readonly string[];
    path: string;
    branch: string;
    process: boolean | undefined;
    strict: boolean;
  },
): Promise<{ refusal?: ReleaseRefusal; detail?: string }> {
  if (!input.worktreesRoots.some((root) => inside(root, input.path))) return { refusal: "not-telars" };
  if (!fs.existsSync(input.path)) return { refusal: "not-found" };
  if (input.process === true || (input.process === undefined && input.strict)) return { refusal: "process" };

  const status = await git(input.path, ["status", "--porcelain"]);
  if (status.status !== 0 || status.timedOut) return { refusal: "dirty", detail: "git could not say whether it is clean" };
  if (status.stdout.trim()) return { refusal: "dirty" };

  const unpushed = await git(input.projectRoot, ["rev-list", "--count", `refs/heads/${input.branch}`, "--not", "--remotes"]);
  if (unpushed.status !== 0 || unpushed.timedOut) return { refusal: "unpushed", detail: "git could not count the unpushed commits" };
  const count = Number(unpushed.stdout.trim());
  if (!Number.isFinite(count) || count > 0) return { refusal: "unpushed", detail: `${unpushed.stdout.trim()} commit(s) on no remote` };
  return {};
}

/** Put a released checkout back where it was, on its own branch. */
export async function reattachSessionWorktreeAsync(
  git: AsyncGitRunner,
  input: { projectRoot: string; path: string; branch: string; timeoutMs?: number },
): Promise<void> {
  await fs.promises.mkdir(path.dirname(input.path), { recursive: true, mode: 0o700 });
  const options = { timeoutMs: input.timeoutMs ?? WORKTREE_ADD_TIMEOUT_MS };
  let added = await git(input.projectRoot, ["worktree", "add", input.path, input.branch], options);
  // A registration left behind by a directory that went some other way makes
  // `add` refuse the path. `--force` for exactly that case — never `prune`,
  // which would also drop every worktree on a drive that is unplugged (#630).
  if (added.status !== 0 && /missing but (locked|already registered)|is a missing but/i.test(added.stderr)) {
    added = await git(input.projectRoot, ["worktree", "add", "--force", input.path, input.branch], options);
  }
  if (added.status !== 0) {
    throw new WorktreeError(`git worktree add failed: ${added.stderr.trim() || added.stdout.trim()}`);
  }
  await lockSessionWorktree(git, input.projectRoot, input.path);
}
