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
 * EVERY GIT CHILD IS BOUNDED. Previously `listProjects` called the synchronous
 * runner in the daemon event loop, freezing all requests. Measured:
 * a `git rev-parse --abbrev-ref HEAD` on a project under ~/Documents blocked for
 * minutes in the kernel (`__getcwd` → `__open_nocancel`), and every
 * `GET /api/projects` timed out behind it until that one process was killed.
 *
 * THE SYNCHRONOUS RUNNER WAS THEN KEPT FOR THE WORKTREE MUTATIONS, and the
 * argument was ordering rather than convenience: two `git worktree add`s at
 * once on one repository race on the same index lock, and a call that blocks
 * until its child exits makes "one at a time" true without anyone having to
 * write a queue. It bought that ordering with the whole daemon. `worktree add`
 * on a large checkout is seconds, and for those seconds every cockpit's poll
 * and every agent's stream stopped together — which is the "creating a
 * conversation takes a while and everything stalls" report (#496).
 *
 * IT NO LONGER IS. The mutations run on `AsyncGitRunner`, and the ordering they
 * were bought with is `createWorktreeQueue`'s instead: one mutation at a time
 * per project, the rest awaiting, nothing holding the loop. The synchronous
 * runner survives for the single-shot reads that never had an ordering
 * requirement to trade for (`clone.ts`, `files.ts`, `gitOverview`, the branch
 * rename) — smaller children, and a separate question from this one.
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

/**
 * A SEPARATE POOL FOR THE MUTATIONS, not a share of the read pool above.
 *
 * `worktree add` is the slowest git child this engine spawns — seconds on a
 * large checkout, against milliseconds for the `rev-parse` a rail poll makes.
 * Drawing both from one four-slot pool would let a handful of concurrent cuts
 * hold every slot, and the reads queued behind them would expire on their own
 * deadlines: not a frozen app, but a rail whose branch labels go stale exactly
 * while somebody is opening sessions. Two pools, and neither can starve the
 * other.
 *
 * TWO SLOTS, because a checkout is disk-bound: cutting four at once is not four
 * times faster, and `createWorktreeQueue` already holds each project to one.
 */
export const defaultWorktreeGitRunner: AsyncGitRunner = createAsyncGitRunner({ concurrency: 2 });

/** Serialise work under a key; see `createWorktreeQueue`. */
export type WorktreeQueue = <T>(key: string, work: () => Promise<T>) => Promise<T>;

/**
 * ONE WORKTREE MUTATION AT A TIME PER PROJECT — the ordering the synchronous
 * runner used to buy by blocking everybody (see `DEFAULT_GIT_TIMEOUT_MS`).
 *
 * WHY ORDERING IS REQUIRED AT ALL: `worktree add` writes the repository's
 * `.git/worktrees` registry and takes the index lock to do it. Two at once on
 * one repository is not slow, it is a `fatal: Unable to create
 * '.../index.lock': File exists` for whichever loses — and the loser is a
 * session a person just asked for.
 *
 * KEYED ON THE PROJECT, NOT GLOBAL, because that is the whole scope of the
 * contention: two projects are two repositories with two locks, and a global
 * queue would make a large checkout's cut delay a cut somewhere unrelated —
 * which is the freeze this issue is about, moved rather than removed.
 *
 * THE TAIL NEVER REJECTS. A failed cut must not reject the call queued behind
 * it, and a rejected promise parked in a map is an unhandled rejection the
 * moment nothing else chains onto it. The caller still sees its own failure;
 * what the chain carries forward is only "that one is finished".
 */
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
 * The create path asks this twice over: to decide whether to REFUSE a stated
 * `worktree`, and to decide whether a standing "worktree by default" preference
 * applies to an unversioned project. One probe, so the two answers cannot drift.
 *
 * STILL SYNCHRONOUS WHILE THE CUT IS NOT, which is the deliberate seam of #496
 * rather than an oversight. What moved to the background is the work measured in
 * seconds; what stays on the request is the work whose ANSWER IS A REFUSAL. A
 * caller that asked for a worktree on a directory that cannot host one has made
 * a bad request, and 201-then-a-failed-row is a worse way to be told than a 4xx
 * that names the problem. This is one `rev-parse --is-inside-work-tree`.
 */
export function isGitWorkTree(git: GitRunner, projectRoot: string): boolean {
  const inside = git(projectRoot, ["rev-parse", "--is-inside-work-tree"]);
  return inside.status === 0 && inside.stdout.trim() === "true";
}

/**
 * Resolve the commit a cut will start from — on the request, for
 * `isGitWorkTree`'s reason: "that ref does not exist" is an answer to the
 * caller, not a state for their row.
 */
export function resolveWorktreeBase(git: GitRunner, projectRoot: string, baseRef?: string): string {
  const requested = baseRef ?? "HEAD";
  const head = git(projectRoot, ["rev-parse", requested]);
  if (head.status !== 0) {
    throw new WorktreeError(`cannot resolve base ref "${requested}": ${head.stderr.trim() || head.stdout.trim()}`);
  }
  return head.stdout.trim();
}

/**
 * WHERE A CUT WILL LAND, decided without touching git or the disk.
 *
 * SPLIT OUT OF THE CUT ITSELF so the session row can carry its final path and
 * branch from the instant it exists, while the checkout is still being made
 * (#496). A row that appeared with no branch and grew one a few seconds later
 * would make the rail's most stable identifier the one field that flickers.
 *
 * It also moves the two branch-name refusals to where a caller can still be
 * told: `sanitizeBranchName`/`sanitizeBranchSlug` throw for a name the engine
 * will not create, and that is an answer to the request rather than a state
 * for the row — so it happens on the request, before anything is written.
 */
export type WorktreePlan = {
  path: string;
  branch: string;
  /** A HUMAN typed this branch name, so the cut uses `-b` and a collision
   *  refuses. An engine-derived name takes `-B`. See the cut below. */
  named: boolean;
};

export function planSessionWorktree(input: {
  engineRoot: string;
  sessionId: string;
  branchSlug?: string;
  /** A human's own name for the new branch — wins over `branchSlug`, lives
   *  OUTSIDE the engine namespaces, and is never reset (see below). */
  branchName?: string;
}): WorktreePlan {
  const named = input.branchName !== undefined ? sanitizeBranchName(input.branchName) : undefined;
  const branch = named ?? (input.branchSlug !== undefined ? sanitizeBranchSlug(input.branchSlug) : `telar/${sanitize(input.sessionId)}`);
  // The directory is named after the branch (minus its namespace prefix), not
  // the session id: the branch is what a human recognises, and the id is
  // recoverable from the session record.
  const dirname = (named ? branch.split("/") : branch.split("/").slice(1)).join("--");
  // The suffix keeps a retry after a partial failure from colliding with the
  // corpse of the previous attempt, which `git worktree add` refuses to reuse.
  const target = path.join(worktreesRoot(input.engineRoot), `${dirname}-${crypto.randomUUID().slice(0, 8)}`);
  return { path: target, branch, named: named !== undefined };
}

/**
 * EVERYTHING A CUT CAN BE REFUSED FOR, asked while the caller is still there.
 *
 * ONE PLACE, because there are now three callers — `createSession`, the browser
 * draft's promotion on first send, and the tests — and a refusal spelled three
 * times is a refusal that means three things by next year. What comes back is
 * what the background step needs and nothing else: where it lands, and what it
 * starts from.
 *
 * THROWS `WorktreeError` FOR ALL FOUR: a directory that is not a repository, a
 * branch name outside what the engine will create, a slug in the wrong shape,
 * and a base ref that does not resolve. See `isGitWorkTree` for why these stay
 * on the request when the cut itself does not.
 */
export function prepareSessionWorktree(
  git: GitRunner,
  input: {
    engineRoot: string;
    projectRoot: string;
    sessionId: string;
    baseRef?: string;
    branchSlug?: string;
    branchName?: string;
  },
): { plan: WorktreePlan; baseSha: string } {
  if (!isGitWorkTree(git, input.projectRoot)) {
    throw new WorktreeError(
      `worktree sessions need a git repository; ${input.projectRoot} is not one. Use envMode "local" for an unversioned project.`,
    );
  }
  // The name before the base: a branch the engine will not create is a refusal
  // that costs no git at all, and ordering it first keeps a bad request cheap.
  const plan = planSessionWorktree(input);
  return { plan, baseSha: resolveWorktreeBase(git, input.projectRoot, input.baseRef) };
}

/**
 * Cut a worktree for a session.
 *
 * ON A BRANCH, NOT DETACHED, which is the opposite of core's default and is
 * deliberate: a detached worktree's commits are unreachable the moment it is
 * removed, and a detached session's whole output is its commits. The branch is
 * the handle a human reviews and merges — without one, "run this overnight"
 * produces work that is technically present and practically lost.
 *
 * ASYNCHRONOUS, AND SERIALISED BY ITS CALLER rather than by blocking — see
 * `createWorktreeQueue`, and `DEFAULT_GIT_TIMEOUT_MS` for what the synchronous
 * version cost.
 */
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
  await fs.promises.mkdir(worktreesRoot(input.engineRoot), { recursive: true, mode: 0o700 });

  // `-B` rather than `-b` FOR ENGINE-OWNED NAMES ONLY: a session recreated
  // after its worktree was reaped would otherwise fail forever on a branch
  // that still exists, and resetting inside `telar/`/`loom/` cannot clobber a
  // human's branch. A HUMAN-named branch takes `-b`: colliding with a branch
  // a person values must refuse, never reset.
  const added = await git(input.projectRoot, ["worktree", "add", plan.named ? "-b" : "-B", plan.branch, plan.path, baseSha]);
  if (added.status !== 0) {
    throw new WorktreeError(`git worktree add failed: ${added.stderr.trim() || added.stdout.trim()}`);
  }
  return { path: plan.path, branch: plan.branch, baseRef: baseSha };
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
export async function removeSessionWorktreeAsync(git: AsyncGitRunner, projectRoot: string, worktreePath: string): Promise<boolean> {
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
