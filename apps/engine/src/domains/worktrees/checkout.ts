import fs from "node:fs";
import path from "node:path";
import { mountRootsFor } from "../../platform/fs/volumes";
import { createAsyncGitRunner, type GitRunner, type AsyncGitRunner } from "../../platform/git/runner";

export const WORKTREE_ADD_TIMEOUT_MS = 120_000;
export const WORKTREE_ADMISSION_MS = 300_000;

export const defaultWorktreeGitRunner: AsyncGitRunner = createAsyncGitRunner({
  concurrency: 2,
  // Cuts wait behind cuts, and a cut may legitimately run for two minutes.
  // See `WORKTREE_ADMISSION_MS`.
  defaultAdmissionMs: WORKTREE_ADMISSION_MS,
});

export class WorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeError";
  }
}

/** Mount roots — where a removable volume appears. The fourth copy of this
 *  list, for the reason `volumes.ts`'s header gives: no app here imports
 *  another, and each says so. */
function isOnRemovableVolume(target: string, platform: NodeJS.Platform = process.platform): boolean {
  // THE ONE LIST (#665). This used to be the fourth copy, and its own comment
  // said so; the win32 hole was in every one of them.
  const roots = mountRootsFor(platform);
  for (const root of roots) {
    const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    if (!target.startsWith(prefix)) continue;
    const [name] = target.slice(prefix.length).split(path.sep);
    if (!name) continue;
    const mount = path.join(root, name);
    try {
      // A mount point's `st_dev` differs from its parent's. An empty folder
      // left where a drive used to be shares its parent's and is not a mount —
      // `volumes.ts`'s `isMountPoint`, and the same reason for it.
      return fs.statSync(mount).dev !== fs.statSync(root).dev;
    } catch {
      return false;
    }
  }
  return false;
}

export function worktreeLockReason(worktreePath: string, platform: NodeJS.Platform = process.platform): string {
  const session =
    "A Telar session is working in this worktree. Telar removes it when that session is archived or deleted — until then, removing it destroys work that is not finished.";
  return isOnRemovableVolume(worktreePath, platform)
    ? `${session} It also sits on a removable volume; unmounting that is not a deletion.`
    : session;
}

export async function lockSessionWorktree(
  git: AsyncGitRunner,
  projectRoot: string,
  worktreePath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  try {
    const locked = await git(projectRoot, ["worktree", "lock", "--reason", worktreeLockReason(worktreePath, platform), worktreePath]);
    return locked.status === 0;
  } catch {
    return false;
  }
}

export async function unlockWorktree(git: AsyncGitRunner, projectRoot: string, worktreePath: string): Promise<void> {
  try {
    await git(projectRoot, ["worktree", "unlock", worktreePath]);
  } catch {
    // Never locked, already unlocked, or a project that cannot answer.
  }
}

export function removeUnregisteredCheckout(target: string, roots: readonly string[]): boolean {
  const resolved = path.resolve(target);
  const parent = path.dirname(resolved);
  if (!roots.some((root) => path.resolve(root) === parent)) return false;
  // `resolve` above collapses `..`; a basename that is still a traversal or the
  // root itself is not a checkout this may touch.
  const name = path.basename(resolved);
  if (!name || name === "." || name === ".." || resolved === parent) return false;
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    return !fs.existsSync(resolved); // Already gone is the outcome asked for.
  }
  // A symlink is removed as the link it is, never followed — but a checkout is
  // a directory, and anything else here is not the thing the row described.
  if (!stat.isDirectory()) return false;
  try {
    fs.rmSync(resolved, { recursive: true, force: true });
  } catch {
    // Best-effort, and the caller reports the honest answer below rather than
    // an exception: a checkout that is still there has not been given back.
  }
  return !fs.existsSync(resolved);
}

export async function repairWorktree(git: AsyncGitRunner, projectRoot: string, worktreePath: string): Promise<boolean> {
  try {
    const repaired = await git(projectRoot, ["worktree", "repair", worktreePath]);
    return repaired.status === 0;
  } catch {
    return false;
  }
}

export function isGitWorkTree(git: GitRunner, projectRoot: string): boolean {
  const inside = git(projectRoot, ["rev-parse", "--is-inside-work-tree"]);
  return inside.status === 0 && inside.stdout.trim() === "true";
}
