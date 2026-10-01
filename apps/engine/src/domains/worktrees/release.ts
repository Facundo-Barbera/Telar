// Release drops a session's checkout but keeps its branch; the re-cut is `worktree add <path> <branch>`, never -B.
// Never released: dirty or unprovable trees, unpushed branches, a process's cwd, anything outside the root.
import fs from "node:fs";
import path from "node:path";
import { lockSessionWorktree, WORKTREE_TREE_TIMEOUT_MS, WorktreeError } from "./checkout";
import { type AsyncGitRunner } from "../../platform/git/runner";
import { lsof } from "../../platform/process/lsof";

export type ReleaseRefusal = "dirty" | "unpushed" | "process" | "not-telars" | "not-found";

function inside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

// undefined when the platform cannot tell (no lsof), which is not "nothing running".
export async function checkoutsWithProcesses(
  checkouts: readonly string[],
  deps: { platform?: NodeJS.Platform; lsof?: () => Promise<string | undefined> } = {},
): Promise<Set<string> | undefined> {
  if ((deps.platform ?? process.platform) === "win32") return undefined;
  const listing = await (deps.lsof ?? (() => lsof(["-n", "-P", "-w", "-d", "cwd", "-F", "n"])))();
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

// `strict` (the automatic sweep) refuses when `processes` is undefined.
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
  const options = { timeoutMs: input.timeoutMs ?? WORKTREE_TREE_TIMEOUT_MS };
  let added = await git(input.projectRoot, ["worktree", "add", input.path, input.branch], options);
  // A registration left behind by a directory that went some other way makes
  // `add` refuse the path. `--force` for exactly that case — never `prune`,
  // which would also drop every worktree on a drive that is unplugged.
  if (added.status !== 0 && /missing but (locked|already registered)|is a missing but/i.test(added.stderr)) {
    added = await git(input.projectRoot, ["worktree", "add", "--force", input.path, input.branch], options);
  }
  if (added.status !== 0) {
    throw new WorktreeError(`git worktree add failed: ${added.stderr.trim() || added.stdout.trim()}`);
  }
  await lockSessionWorktree(git, input.projectRoot, input.path);
}
