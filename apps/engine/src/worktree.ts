/**
 * Per-session git worktrees.
 *
 * WHY THIS EXISTS: it is the precondition for running several detached sessions
 * on one project at once. Two agents editing one checkout produce a diff nobody
 * can attribute and a `git status` that belongs to neither of them. Conductor
 * made this its core idea; t3 code encodes the same choice as
 * `ThreadEnvMode = "local" | "worktree"`.
 *
 * WHY NOT `packages/core/src/vcs.ts`'s `addWorktree`, which already exists and
 * works. Two reasons, and the second is the load-bearing one:
 *
 *   1. It composes its path off core's `telarDir()`, so worktrees would land in
 *      `<TELAR_HOME>/worktrees` — a subtree AD-5 assigns to `vcs.ts`. The engine
 *      writing there would make a second owner of someone else's subtree, which
 *      is precisely what INV-3 exists to prevent.
 *   2. `@telar/core`'s package exports are `"."` only, so there is no subpath
 *      import: pulling in `addWorktree` pulls in the whole barrel — the loom
 *      engine, the Claude SDK, the schemas. `state.ts`'s header promises the
 *      daemon is a new island that "never imports legacy Telar storage", and
 *      that promise is worth more than the ~40 lines saved here.
 *
 * So the engine owns `<TELAR_HOME>/vnext/worktrees` — inside its own root, not
 * a sibling of core's.
 */
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type GitResult = { status: number; stdout: string; stderr: string };
/** Injectable so tests never need a real repository. */
export type GitRunner = (cwd: string, args: string[]) => GitResult;

export const defaultGitRunner: GitRunner = (cwd, args) => {
  try {
    const stdout = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? String(error) };
  }
};

export class WorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeError";
  }
}

/** Only characters that are safe in a path segment AND in a git ref. */
function sanitize(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "session";
}

export function worktreesRoot(vnextRoot: string): string {
  return path.join(vnextRoot, "worktrees");
}

/**
 * Cut a worktree for a session.
 *
 * ON A BRANCH, NOT DETACHED, which is the opposite of core's default and is
 * deliberate: a detached worktree's commits are unreachable the moment it is
 * removed, and a detached session's whole output is its commits. The branch is
 * the handle a human reviews and merges — without one, "run this overnight"
 * produces work that is technically present and practically lost.
 */
export function createSessionWorktree(
  git: GitRunner,
  input: { vnextRoot: string; projectRoot: string; sessionId: string; baseRef?: string },
): { path: string; branch: string; baseRef: string } {
  const inside = git(input.projectRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.status !== 0 || inside.stdout.trim() !== "true") {
    throw new WorktreeError(
      `worktree sessions need a git repository; ${input.projectRoot} is not one. Use envMode "local" for an unversioned project.`,
    );
  }

  const baseRef = input.baseRef ?? "HEAD";
  const head = git(input.projectRoot, ["rev-parse", baseRef]);
  if (head.status !== 0) {
    throw new WorktreeError(`cannot resolve base ref "${baseRef}": ${head.stderr.trim() || head.stdout.trim()}`);
  }
  const baseSha = head.stdout.trim();

  const id = sanitize(input.sessionId);
  const root = worktreesRoot(input.vnextRoot);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  // The suffix keeps a retry after a partial failure from colliding with the
  // corpse of the previous attempt, which `git worktree add` refuses to reuse.
  const target = path.join(root, `${id}-${crypto.randomUUID().slice(0, 8)}`);
  const branch = `telar/${id}`;

  // `-B` rather than `-b`: a session recreated after its worktree was reaped
  // would otherwise fail forever on a branch name that still exists. The
  // branch is engine-owned and namespaced under `telar/`, so resetting it
  // cannot clobber a human's branch.
  const added = git(input.projectRoot, ["worktree", "add", "-B", branch, target, baseSha]);
  if (added.status !== 0) {
    throw new WorktreeError(`git worktree add failed: ${added.stderr.trim() || added.stdout.trim()}`);
  }
  return { path: target, branch, baseRef: baseSha };
}

/**
 * Best-effort removal.
 *
 * RETURNS WHETHER THE DIRECTORY IS ACTUALLY GONE, because that is the caller's
 * only reliable signal: the runner reports a failed `git worktree remove` as a
 * non-zero status rather than throwing, and the `prune` that follows would
 * otherwise make a failure indistinguishable from a success. Core's
 * `removeWorktree` learned this the same way and its comment says so.
 *
 * THE BRANCH IS DELIBERATELY NOT DELETED. It is the session's output. Removing
 * the worktree frees the checkout; destroying the commits is a separate,
 * human decision.
 */
export function removeSessionWorktree(git: GitRunner, projectRoot: string, worktreePath: string): boolean {
  try {
    git(projectRoot, ["worktree", "remove", "--force", worktreePath]);
  } catch {
    // Best-effort: the default runner never throws, this guards a fake that might.
  }
  try {
    git(projectRoot, ["worktree", "prune"]);
  } catch {
    // Same.
  }
  return !fs.existsSync(worktreePath);
}
