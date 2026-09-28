import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ProjectAvailability } from "../../platform/fs/volumes";
import { defaultWorktreesRoot, readWorktreesRoot, rootOf, worktreesRootBlocker, type WorktreesRootState } from "./location";
import { detectCacheDedup, type CacheDedupVerdict } from "../storage";
import type { GitRunner, AsyncGitRunner } from "../../platform/git/runner";
import { WORKTREE_ADD_TIMEOUT_MS, WorktreeError, lockSessionWorktree, unlockWorktree, isGitWorkTree } from "./checkout";

/** Serialise work under a key; see `createWorktreeQueue`. */
export type WorktreeQueue = <T>(key: string, work: () => Promise<T>) => Promise<T>;

export function createWorktreeQueue(): WorktreeQueue {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const prior = tails.get(key);
    const run = prior === undefined ? work() : prior.then(work);
    const tail: Promise<unknown> = run.then(() => undefined, () => undefined);
    tails.set(key, tail);
    // Drop the key once the queue for it has drained, so a machine that opened
    // sessions on forty projects this week holds forty settled promises rather
    // than forever.
    void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
    return run;
  };
}

/** Only characters that are safe in a path segment AND in a git ref. */
function sanitize(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "session";
}

function sanitizeBranchSlug(slug: string): string {
  const segments = slug.split("/").map((s) => s.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 48));
  if (segments.length < 2 || segments.length > 3 || segments.some((s) => s === "")) {
    throw new WorktreeError(`branch slug "${slug}" must be 2-3 non-empty segments, e.g. loom/<loom>/<thread>`);
  }
  if (segments[0] !== "loom" && segments[0] !== "telar") {
    throw new WorktreeError(`branch slug "${slug}" must live under loom/ or telar/ — those are the engine-owned namespaces`);
  }
  return segments.join("/");
}

function sanitizeBranchName(name: string): string {
  const trimmed = name.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/.test(trimmed) || trimmed.endsWith("/") || trimmed.includes("//") || trimmed.includes("..")) {
    throw new WorktreeError(`branch name "${name}" is not a usable git branch name`);
  }
  if (trimmed === "loom" || trimmed === "telar" || trimmed.startsWith("loom/") || trimmed.startsWith("telar/")) {
    throw new WorktreeError(`branch name "${name}" is inside an engine-owned namespace; pick a name outside loom/ and telar/`);
  }
  return trimmed;
}

function resolveWorktreeBase(git: GitRunner, projectRoot: string, baseRef?: string): string {
  const requested = baseRef ?? "HEAD";
  const head = git(projectRoot, ["rev-parse", requested]);
  if (head.status !== 0) {
    throw new WorktreeError(`cannot resolve base ref "${requested}": ${head.stderr.trim() || head.stdout.trim()}`);
  }
  return head.stdout.trim();
}

export type WorktreePlan = {
  path: string;
  branch: string;
  /** A HUMAN typed this branch name, so the cut uses `-b` and a collision
   *  refuses. An engine-derived name takes `-B`. See the cut below. */
  named: boolean;
};

function planSessionWorktree(input: {
  engineRoot: string;
  sessionId: string;
  branchSlug?: string;
  /** A human's own name for the new branch — wins over `branchSlug`, lives
   *  OUTSIDE the engine namespaces, and is never reset (see below). */
  branchName?: string;
  worktreesRoot?: string;
}): WorktreePlan {
  const named = input.branchName !== undefined ? sanitizeBranchName(input.branchName) : undefined;
  const branch = named ?? (input.branchSlug !== undefined ? sanitizeBranchSlug(input.branchSlug) : `telar/${sanitize(input.sessionId)}`);
  // The directory is named after the branch (minus its namespace prefix), not
  // the session id: the branch is what a human recognises, and the id is
  // recoverable from the session record.
  const dirname = (named ? branch.split("/") : branch.split("/").slice(1)).join("--");
  // The suffix keeps a retry after a partial failure from colliding with the
  // corpse of the previous attempt, which `git worktree add` refuses to reuse.
  const target = path.join(input.worktreesRoot ?? defaultWorktreesRoot(input.engineRoot), `${dirname}-${crypto.randomUUID().slice(0, 8)}`);
  return { path: target, branch, named: named !== undefined };
}

export function prepareSessionWorktree(
  git: GitRunner,
  input: {
    engineRoot: string;
    projectRoot: string;
    sessionId: string;
    baseRef?: string;
    branchSlug?: string;
    branchName?: string;
    /** What the store's probe said about the project's disk, when there is one.
     *  See `ProjectAvailability`. */
    availability?: ProjectAvailability;
    /** The project's name, for the sentence a person reads when the drive is
     *  away. The path is not what they call it. */
    projectName?: string;
    /** Where this install puts checkouts (#642 part 2). Read from engine state
     *  when absent; injected by tests and by a caller that already asked. */
    worktreesRoot?: WorktreesRootState;
  },
): { plan: WorktreePlan; baseSha: string } {
  const location = input.worktreesRoot ?? readWorktreesRoot(input.engineRoot);
  const blocked = worktreesRootBlocker(location);
  if (blocked) throw new WorktreeError(blocked);
  if (input.availability === "unmounted") {
    throw new WorktreeError(
      `The drive holding ${input.projectName ?? input.projectRoot} is not connected. Plug it back in and this will work again.`,
    );
  }
  if (input.availability === "missing") {
    throw new WorktreeError(`The folder for ${input.projectName ?? input.projectRoot} is not on this machine any more (${input.projectRoot}).`);
  }
  if (!isGitWorkTree(git, input.projectRoot)) {
    throw new WorktreeError(
      `worktree sessions need a git repository; ${input.projectRoot} is not one. Use envMode "local" for an unversioned project.`,
    );
  }
  // The name before the base: a branch the engine will not create is a refusal
  // that costs no git at all, and ordering it first keeps a bad request cheap.
  const { worktreesRoot: _asked, ...rest } = input;
  const root = rootOf(location);
  const plan = planSessionWorktree({ ...rest, ...(root ? { worktreesRoot: root } : {}) });
  return {
    plan,
    baseSha: resolveWorktreeBase(git, input.projectRoot, input.baseRef),
    ...(root ? { caches: cacheDedupNotice(root) } : {}),
  };
}

function cacheDedupNotice(worktreesRoot: string): CacheDedupVerdict[] {
  return detectCacheDedup(worktreesRoot).filter((verdict) => verdict.dedup !== "same-device");
}

export async function createSessionWorktreeAsync(
  git: AsyncGitRunner,
  input: {
    engineRoot: string;
    projectRoot: string;
    /** Where it lands, decided on the request so the row could publish it. */
    plan: WorktreePlan;
    /** Already resolved by `resolveWorktreeBase`, for the same reason. */
    baseSha: string;
  },
): Promise<{ path: string; branch: string; baseRef: string }> {
  const { plan, baseSha } = input;
  await fs.promises.mkdir(path.dirname(plan.path), { recursive: true, mode: 0o700 });

  const added = await git(
    input.projectRoot,
    ["worktree", "add", plan.named ? "-b" : "-B", plan.branch, plan.path, baseSha],
    { timeoutMs: WORKTREE_ADD_TIMEOUT_MS },
  );
  if (added.status !== 0) {
    throw new WorktreeError(`git worktree add failed: ${added.stderr.trim() || added.stdout.trim()}`);
  }
  // LOCKED THE MOMENT IT EXISTS — #630 for the unmount, #641 for `gh pr merge
  // --delete-branch`. Before the cut returns, so there is no window in which
  // either could read as permission to delete it.
  await lockSessionWorktree(git, input.projectRoot, plan.path);
  return { path: plan.path, branch: plan.branch, baseRef: baseSha };
}

export async function removeSessionWorktreeAsync(
  git: AsyncGitRunner,
  projectRoot: string,
  worktreePath: string,
  availability?: ProjectAvailability,
): Promise<boolean> {
  if (availability !== undefined && availability !== "available") {
    return !fs.existsSync(worktreePath);
  }
  const root = path.dirname(worktreePath);
  if (!fs.existsSync(root)) return false;
  await unlockWorktree(git, projectRoot, worktreePath);
  try {
    await git(projectRoot, ["worktree", "remove", "--force", worktreePath]);
  } catch {
    // Best-effort: the default runner never throws, this guards a fake that might.
  }
  try {
    await git(projectRoot, ["worktree", "prune"]);
  } catch {
    // Same.
  }
  return !fs.existsSync(worktreePath);
}

// The one derivation both the session cut and the title rename check against.
export function derivedBranchFor(title: string, sessionId: string): string | undefined {
  const slug = title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug ? `telar/${slug}-${sessionId.replace(/^session_/, "").slice(0, 6)}` : undefined;
}
