import fs from "node:fs";
import path from "node:path";
import { mountPointForRoot } from "../../platform/fs/volumes";
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

export function worktreeLockReason(worktreePath: string, platform: NodeJS.Platform = process.platform): string {
  const session =
    "A Telar session is working in this worktree. Telar removes it when that session is archived or deleted — until then, removing it destroys work that is not finished.";
  return mountPointForRoot(worktreePath, { platform }) !== undefined
    ? `${session} It also sits on a removable volume; unmounting that is not a deletion.`
    : session;
}

export async function lockSessionWorktree(
  git: AsyncGitRunner,
  projectRoot: string,
  worktreePath: string,
): Promise<boolean> {
  try {
    const locked = await git(projectRoot, ["worktree", "lock", "--reason", worktreeLockReason(worktreePath), worktreePath]);
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
