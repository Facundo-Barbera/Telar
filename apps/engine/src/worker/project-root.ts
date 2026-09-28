import fs from "node:fs";
import { isMountPoint, mountPointForRoot, type VolumeDeps } from "../platform/fs/volumes";

/** Present exactly when the session's cwd is a worktree rather than the project's checkout. */
type WorktreeFacts = { branch: string; repoRoot: string };

function missingWorktreeMessage(cwd: string, worktree: WorktreeFacts, exists: (path: string) => boolean): string {
  const project = exists(worktree.repoRoot)
    ? `The project itself is fine — it is still at ${worktree.repoRoot}, so do NOT re-register it; that would give it a new id and leave this session's history behind.`
    : `The project's own checkout at ${worktree.repoRoot} is missing too, so this is a larger loss than one worktree — check that path before anything else.`;
  return [
    `This session's worktree ${cwd} no longer exists.`,
    project,
    "A worktree goes when its session is archived or deleted, or when something outside Telar removes it — `gh pr merge --delete-branch` runs `git worktree remove` on whichever worktree holds the branch it is deleting, which takes the directory, the local branch and git's registration together.",
    `This session cannot continue in a checkout that is not there. Anything it had committed is on ${worktree.branch} if that branch survives (\`git branch -a --contains\`) and in the branch it was merged into either way; anything uncommitted went with the directory. Start a session on the project from whichever of those still exists.`,
  ].join(" ");
}

/**
 * Throws a readable reason when a provider cannot be spawned in `cwd`. The drive check comes
 * first: macOS leaves an empty `/Volumes/<name>` behind, which passes every later check.
 */
export function assertProjectRoot(cwd: string, volumes: VolumeDeps = {}, worktree?: WorktreeFacts): void {
  const mount = mountPointForRoot(cwd, volumes);
  if (mount !== undefined && !isMountPoint(mount, volumes)) {
    throw new Error(
      `The drive holding this project is not connected (${mount}). Plug it back in and retry — do not re-register the project from another path, which would give it a new id and leave this session's history behind.`,
    );
  }
  const what = worktree ? "This session's worktree" : "The project folder";
  let stat: fs.Stats;
  try {
    stat = fs.statSync(cwd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        worktree
          ? missingWorktreeMessage(cwd, worktree, (target) => fs.existsSync(target))
          : `The project folder ${cwd} does not exist. It may have been moved or deleted; re-register the project with its current location (or restore the folder) and retry.`,
      );
    }
    throw new Error(`${what} ${cwd} cannot be accessed (${code ?? "unknown error"}). Check its permissions and retry.`);
  }
  if (!stat.isDirectory()) {
    throw new Error(
      worktree
        ? `This session's worktree path ${cwd} is not a folder. Something replaced it; the project at ${worktree.repoRoot} is unaffected.`
        : `The project path ${cwd} is not a folder. Re-register the project with its checkout directory and retry.`,
    );
  }
  try {
    fs.accessSync(cwd, fs.constants.R_OK | fs.constants.X_OK);
  } catch {
    throw new Error(`${what} ${cwd} is not readable by this user. Check its permissions and retry.`);
  }
}
