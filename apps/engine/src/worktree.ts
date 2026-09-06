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
 * So the engine owns `<TELAR_HOME>/engine/worktrees` — inside its own root, not
 * a sibling of core's.
 */
import crypto from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type GitResult = {
  status: number;
  stdout: string;
  stderr: string;
  /** Set when the child was killed for outrunning its bound rather than exiting on its own. */
  timedOut?: true;
};
export type GitRunOptions = {
  /** Wall-clock bound for this one invocation; the runner's default otherwise. */
  timeoutMs?: number;
};
/** Injectable so tests never need a real repository. */
export type GitRunner = (cwd: string, args: string[], options?: GitRunOptions) => GitResult;

/**
 * EVERY GIT CHILD IS BOUNDED. The synchronous runner remains for mutation
 * paths; polling uses the asynchronous runner below. Previously listProjects
 * called this in the daemon event loop, freezing all requests. Measured:
 * a `git rev-parse --abbrev-ref HEAD` on a project under ~/Documents blocked for
 * minutes in the kernel (`__getcwd` → `__open_nocancel`), and every
 * `GET /api/projects` timed out behind it until that one process was killed.
 *
 * Generous enough for a `worktree add` on a large checkout, small enough that a
 * stall is a stale branch label for a moment rather than a frozen app.
 * `TELAR_GIT_TIMEOUT_MS` overrides it for a machine where the default is wrong.
 */
export const DEFAULT_GIT_TIMEOUT_MS = 30_000;

/** The status a timed-out child reports — coreutils' `timeout` convention. */
export const GIT_TIMEOUT_STATUS = 124;

export type GitRunnerDeps = {
  /** Which binary to run; `git` from PATH by default. Tests point it at a stalled fake. */
  gitBin?: string;
  defaultTimeoutMs?: number;
};

export function createGitRunner(deps: GitRunnerDeps = {}): GitRunner {
  const gitBin = deps.gitBin ?? "git";
  return (cwd, args, options) => {
    const timeout = Math.max(1, options?.timeoutMs ?? deps.defaultTimeoutMs ?? gitTimeoutFromEnv());
    try {
      const stdout = execFileSync(gitBin, args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout,
        // SIGKILL, NOT SIGTERM: the stall this guards against is a child stuck
        // in a syscall, and a signal git may handle politely is a signal it may
        // never get around to handling.
        killSignal: "SIGKILL",
      });
      return { status: 0, stdout, stderr: "" };
    } catch (error) {
      const failure = error as { code?: string; signal?: string | null; status?: number | null; stdout?: string; stderr?: string };
      if (failure.code === "ETIMEDOUT" || (failure.status == null && failure.signal === "SIGKILL")) {
        return {
          status: GIT_TIMEOUT_STATUS,
          stdout: failure.stdout ?? "",
          stderr: `git ${args.join(" ")} in ${cwd} did not finish within ${timeout}ms and was killed`,
          timedOut: true,
        };
      }
      return { status: failure.status ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr || String(error) };
    }
  };
}

function gitTimeoutFromEnv(): number {
  const raw = Number(process.env.TELAR_GIT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_GIT_TIMEOUT_MS;
}

export const defaultGitRunner: GitRunner = createGitRunner();

export type AsyncGitRunner = (cwd: string, args: string[], options?: GitRunOptions) => Promise<GitResult>;

/** Read paths share a small process pool so polling cannot flood the machine.
 * The deadline includes queue time, and completion never waits on a stuck child.
 */
export function createAsyncGitRunner(deps: GitRunnerDeps & { concurrency?: number } = {}): AsyncGitRunner {
  const requestedLimit = deps.concurrency ?? 4;
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.floor(requestedLimit)) : 4;
  let active = 0;
  const queue: Array<() => void> = [];
  return (cwd, args, options) => new Promise((resolve) => {
    const requested = options?.timeoutMs ?? deps.defaultTimeoutMs ?? gitTimeoutFromEnv();
    const timeout = Number.isFinite(requested) ? Math.max(1, requested) : DEFAULT_GIT_TIMEOUT_MS;
    let settled = false;
    let child: ReturnType<typeof execFile> | undefined;
    const finish = (result: GitResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      const index = queue.indexOf(start);
      if (index !== -1) queue.splice(index, 1);
      child?.kill("SIGKILL");
      finish({ status: GIT_TIMEOUT_STATUS, stdout: "", stderr: `git ${args.join(" ")} in ${cwd} did not finish within ${timeout}ms and was killed`, timedOut: true });
    }, timeout);
    const start = () => {
      if (settled) return;
      active++;
      const release = () => {
        active--;
        queue.shift()?.();
      };
      try {
        child = execFile(deps.gitBin ?? "git", args, {
          cwd, encoding: "utf8", maxBuffer: 1024 * 1024, killSignal: "SIGKILL",
        }, (error, stdout, stderr) => {
          release();
          finish({ status: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr: stderr || (error ? String(error) : "") });
        });
      } catch (error) {
        release();
        finish({ status: 1, stdout: "", stderr: String(error) });
      }
    };
    if (active < limit) start();
    else queue.push(start);
  });
}

export const defaultAsyncGitRunner: AsyncGitRunner = createAsyncGitRunner();


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

/**
 * A caller-proposed branch name, e.g. `loom/hito1-agosto/presupuestos` or
 * `telar/fix-login-a3f9c1`.
 *
 * MUST live under `loom/` or `telar/` — the branch is created with `-B`, which
 * resets an existing branch of the same name, and that is only safe inside a
 * namespace humans do not use. Anything else is refused rather than silently
 * renamed, so the caller learns its naming scheme is wrong instead of hunting
 * for a branch that is not where it said it would be.
 */
export function sanitizeBranchSlug(slug: string): string {
  const segments = slug.split("/").map((s) => s.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 48));
  if (segments.length < 2 || segments.length > 3 || segments.some((s) => s === "")) {
    throw new WorktreeError(`branch slug "${slug}" must be 2-3 non-empty segments, e.g. loom/<loom>/<thread>`);
  }
  if (segments[0] !== "loom" && segments[0] !== "telar") {
    throw new WorktreeError(`branch slug "${slug}" must live under loom/ or telar/ — those are the engine-owned namespaces`);
  }
  return segments.join("/");
}

/**
 * A HUMAN-chosen branch name — the "new branch…" arm of the base picker.
 *
 * The opposite posture from `sanitizeBranchSlug`: any namespace EXCEPT the
 * engine-owned ones, and the branch is created with `-b`, never `-B` — a name
 * a person typed may collide with a branch a person values, and the only safe
 * answer to that collision is a refusal that names it. Validation is
 * charset-conservative rather than a full check-ref-format: every name it
 * admits is a valid ref, not the reverse.
 */
export function sanitizeBranchName(name: string): string {
  const trimmed = name.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/.test(trimmed) || trimmed.endsWith("/") || trimmed.includes("//") || trimmed.includes("..")) {
    throw new WorktreeError(`branch name "${name}" is not a usable git branch name`);
  }
  if (trimmed === "loom" || trimmed === "telar" || trimmed.startsWith("loom/") || trimmed.startsWith("telar/")) {
    throw new WorktreeError(`branch name "${name}" is inside an engine-owned namespace; pick a name outside loom/ and telar/`);
  }
  return trimmed;
}

export function worktreesRoot(engineRoot: string): string {
  return path.join(engineRoot, "worktrees");
}

/**
 * Can this directory host a worktree at all?
 *
 * `createSessionWorktree` asks this to decide whether to THROW; the create path
 * asks it to decide whether a standing "worktree by default" preference applies
 * to an unversioned project. One probe, so the two answers cannot drift.
 */
export function isGitWorkTree(git: GitRunner, projectRoot: string): boolean {
  const inside = git(projectRoot, ["rev-parse", "--is-inside-work-tree"]);
  return inside.status === 0 && inside.stdout.trim() === "true";
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
  input: {
    engineRoot: string;
    projectRoot: string;
    sessionId: string;
    baseRef?: string;
    branchSlug?: string;
    /** A human's own name for the new branch — wins over `branchSlug`, lives
     *  OUTSIDE the engine namespaces, and is never reset (see below). */
    branchName?: string;
  },
): { path: string; branch: string; baseRef: string } {
  if (!isGitWorkTree(git, input.projectRoot)) {
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

  const named = input.branchName !== undefined ? sanitizeBranchName(input.branchName) : undefined;
  const branch = named ?? (input.branchSlug !== undefined ? sanitizeBranchSlug(input.branchSlug) : `telar/${sanitize(input.sessionId)}`);
  // The directory is named after the branch (minus its namespace prefix), not
  // the session id: the branch is what a human recognises, and the id is
  // recoverable from the session record.
  const dirname = (named ? branch.split("/") : branch.split("/").slice(1)).join("--");
  const root = worktreesRoot(input.engineRoot);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  // The suffix keeps a retry after a partial failure from colliding with the
  // corpse of the previous attempt, which `git worktree add` refuses to reuse.
  const target = path.join(root, `${dirname}-${crypto.randomUUID().slice(0, 8)}`);

  // `-B` rather than `-b` FOR ENGINE-OWNED NAMES ONLY: a session recreated
  // after its worktree was reaped would otherwise fail forever on a branch
  // that still exists, and resetting inside `telar/`/`loom/` cannot clobber a
  // human's branch. A HUMAN-named branch takes `-b`: colliding with a branch
  // a person values must refuse, never reset.
  const added = git(input.projectRoot, ["worktree", "add", named ? "-b" : "-B", branch, target, baseSha]);
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
