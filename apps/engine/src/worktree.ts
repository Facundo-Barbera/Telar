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
 *
 * ══ A WORKTREE AND ITS REPOSITORY CAN BE ON DIFFERENT DISKS — issue #534 ══
 *
 * That follows from the paragraph above and was never a design goal: the engine
 * root is on this Mac's own disk, so a project registered from an external drive
 * has its `.git` on the drive and every worktree cut from it in
 * `<TELAR_HOME>/engine/worktrees` on the internal one. The directory and the
 * repository it belongs to are separately reachable.
 *
 * WHAT THAT MEANS WHEN THE DRIVE IS UNPLUGGED. The worktree directory is still
 * perfectly readable — the files are right there — and every `git` command
 * inside it fails, because the `.git` file in it points at a `gitdir` on a disk
 * that is not present. On remount it all works again, unchanged and with no
 * repair step: nothing was broken, something was absent.
 *
 * SO `git worktree prune` MUST NEVER RUN WHILE A PROJECT IS UNAVAILABLE, and
 * this is the rule the module exists to state. `prune` is the only operation
 * here that DELETES git's own records, and it decides what to delete by asking
 * which registered worktree directories still exist. Asking that question of a
 * repository nobody can read is asking it of an answer nobody has: on the
 * recreated-empty-mountpoint case (`volumes.ts`) git can even be pointed at a
 * *different* tree at the same path, and the registrations it would then find
 * unaccounted for belong to sessions whose work is sitting on the drive in
 * somebody's bag. The removal is best-effort and a leaked worktree is bounded
 * and reapable; a pruned registration is neither.
 *
 * `removeSessionWorktreeAsync` takes the project's availability and refuses on
 * anything but `available`. The caller passes what the store's one probe said —
 * see `EngineStore.projectAvailability`.
 *
 * ══ AND SINCE #630 THE ARRANGEMENT CAN ALSO BE THE OTHER WAY AROUND ══
 *
 * Everything above was reasoned for ONE direction: engine root on the internal
 * disk, project possibly on a drive. The store may now itself live on a volume,
 * which makes "the project is readable" and "the worktree is readable" two
 * different questions — and the guard above only asks the first. See the block
 * above `lockSessionWorktree` for the case that opens up, why `git worktree
 * lock` is the answer git already provides, and why locking without an unlock
 * path would trade a data-loss bug for a leak-forever one.
 */
import crypto from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ProjectAvailability } from "./volumes";
import { defaultWorktreesRoot, readWorktreesRoot, rootOf, worktreesRootBlocker, type WorktreesRootState } from "./worktrees-location";

export type GitResult = {
  status: number;
  stdout: string;
  stderr: string;
  /** Set when the child was killed for outrunning its bound rather than exiting on its own. */
  timedOut?: true;
  /**
   * The pid of the child this runner killed, on the timeout path of the
   * synchronous runner — absent everywhere else, including when the spawn itself
   * failed and there was no child. It exists so "the child was killed rather than
   * orphaned" can be checked without the child having to write its own pid
   * somewhere first, which is what #748 was: a race between the fixture's startup
   * and the bound under test.
   */
  killedPid?: number;
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

/**
 * `spawnSync`, NOT `execFileSync`, FOR ONE REASON: IT RETURNS THE PID (#748).
 *
 * Both block, both kill at `timeout`, both reap the direct child before they
 * return. What `execFileSync` cannot do is say WHICH process it killed, and
 * without that the only way to check a stalled child was actually killed rather
 * than abandoned was to have the child write its own pid to a file and read it
 * back afterwards — which made the test's bound double as the child's startup
 * deadline. The pid file existed only if `sh` reached its first line inside the
 * same 1,500 ms the runner was being measured against, so the test passed at
 * 1503 ms and failed at 1507 ms four minutes later, with `ENOENT` meaning the
 * shell never started rather than that a write was lost.
 *
 * Reporting the pid removes the file, the race and the `ENOENT` together: the
 * pid exists because the spawn happened, not because the child cooperated.
 * `killedPid` is set only on the timeout path, so it means exactly what it says —
 * the process this runner killed — and it goes into the message too, where a log
 * naming the pid it killed is worth more than one that does not.
 */
export function createGitRunner(deps: GitRunnerDeps = {}): GitRunner {
  const gitBin = deps.gitBin ?? "git";
  return (cwd, args, options) => {
    const timeout = Math.max(1, options?.timeoutMs ?? deps.defaultTimeoutMs ?? gitTimeoutFromEnv());
    const run = spawnSync(gitBin, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
      // SIGKILL, NOT SIGTERM: the stall this guards against is a child stuck
      // in a syscall, and a signal git may handle politely is a signal it may
      // never get around to handling.
      killSignal: "SIGKILL",
    });
    const failure = run.error as { code?: string } | undefined;
    // The second clause is the one `execFileSync` used to need and is kept: a
    // child that died on SIGKILL with no status is one this runner killed, even
    // where the platform did not also hand back an ETIMEDOUT.
    if (failure?.code === "ETIMEDOUT" || (run.status == null && run.signal === "SIGKILL")) {
      const killed = typeof run.pid === "number" && run.pid > 0 ? run.pid : undefined;
      return {
        status: GIT_TIMEOUT_STATUS,
        stdout: run.stdout ?? "",
        stderr:
          `git ${args.join(" ")} in ${cwd} did not finish within ${timeout}ms and was killed` +
          (killed === undefined ? "" : ` (pid ${killed})`),
        timedOut: true,
        killedPid: killed,
      };
    }
    if (run.status === 0) return { status: 0, stdout: run.stdout ?? "", stderr: "" };
    return {
      status: run.status ?? 1,
      stdout: run.stdout ?? "",
      // `spawnSync` reports a failure to START in `error` with no stderr at all —
      // a missing binary arrives as ENOENT and `stderr: null` — so the error is
      // what stands in for a message the child never got to write.
      stderr: run.stderr || (run.error ? String(run.error) : `git ${args.join(" ")} in ${cwd} exited with status ${run.status}`),
    };
  };
}

function gitTimeoutFromEnv(): number {
  const raw = Number(process.env.TELAR_GIT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_GIT_TIMEOUT_MS;
}

export const defaultGitRunner: GitRunner = createGitRunner();

export type AsyncGitRunner = (cwd: string, args: string[], options?: GitRunOptions) => Promise<GitResult>;

/**
 * Read paths share a small process pool so polling cannot flood the machine.
 * The deadline includes queue time, and NEITHER THE CALLER NOR THE POOL waits on
 * a stuck child: a read that expires frees its slot at its own deadline.
 *
 * THE SLOT IS FREED AT THE DEADLINE, NOT AT THE REAP — issue #743.
 *
 * `SIGKILL` reaps git. It does not reap what git spawned: a clean/smudge filter,
 * a `textconv` driver, an fsmonitor hook. Those inherit git's stderr, and
 * `execFile`'s callback fires on stdio EOF rather than on process exit — so the
 * callback, which is where `release` used to live, waits for the HELPER, not for
 * git. Measured on a real `git diff` whose clean filter left a six-second helper
 * behind: the caller was freed at its 400 ms deadline and the slot stayed held a
 * further 5.6 s. A helper that never exits holds the slot forever, which makes
 * this a leak rather than the delay it looks like.
 *
 * THE TRADE, because it changes what `concurrency` means. Until #743 a slot was
 * held until the process tree was gone, so `limit` bounded live git processes as
 * well as in-flight reads. Now it bounds only the reads: a slot can be handed out
 * while an expired read's orphaned helper is still alive, so more than `limit`
 * git-spawned processes can briefly exist. That is the deliberate half of the
 * exchange — capacity is the thing polling needs back, and an orphan that
 * survived `SIGKILL` was never going to be freed by making the next reader wait
 * for it.
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
    /**
     * ACQUIRED, not "started": a read that expires while still QUEUED never
     * incremented `active`, and releasing on its behalf would hand out a slot
     * that was never taken. `released` makes the call idempotent, because both
     * the timeout path and the eventual `execFile` callback now reach it — the
     * callback still arrives, whenever the orphaned helper finally lets go.
     */
    let acquired = false;
    let released = false;
    const release = () => {
      if (!acquired || released) return;
      released = true;
      active--;
      queue.shift()?.();
    };
    const timer = setTimeout(() => {
      const index = queue.indexOf(start);
      if (index !== -1) queue.splice(index, 1);
      child?.kill("SIGKILL");
      release();
      finish({ status: GIT_TIMEOUT_STATUS, stdout: "", stderr: `git ${args.join(" ")} in ${cwd} did not finish within ${timeout}ms and was killed`, timedOut: true });
    }, timeout);
    const start = () => {
      if (settled) return;
      active++;
      acquired = true;
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

/**
 * WHERE CHECKOUTS GO WITH NOTHING CONFIGURED — #642 part 2 made this the
 * DEFAULT rather than the answer.
 *
 * It lives in `worktrees-location.ts` now, beside the record that can override
 * it, and is re-exported here because this module is where a reader looks for
 * it. There is one definition; a second spelling of "engine root plus
 * worktrees" is a thing to forget when the default moves.
 */
export { defaultWorktreesRoot } from "./worktrees-location";

/**
 * ══ AND NOW THE ENGINE ROOT ITSELF CAN BE ON A DRIVE — issue #630 ══
 *
 * Everything above reasons about a worktree on the internal disk whose PROJECT
 * may be away. That was the only arrangement possible while the engine root was
 * fixed. It is not any more, and the two facts come apart in a way that makes
 * the existing guard insufficient rather than wrong:
 *
 *   the project is on the internal disk and perfectly available,
 *   the WORKTREE's own volume is out,
 *   so `removeSessionWorktreeAsync`'s availability check passes,
 *   and the `prune` it runs deletes the registration of every worktree on the
 *   absent drive — not just the one being removed.
 *
 * Removing a single session while the drive is unplugged would take out all of
 * them. A pruned registration is the unrecoverable half of this module's
 * original argument; the work is sitting on the drive in somebody's bag.
 *
 * GIT HAS A FIRST-CLASS ANSWER AND WE WERE NOT USING IT. `git worktree lock` is
 * documented for exactly this — a worktree on a portable device or a network
 * share — and a locked worktree is ignored by `prune` however long its
 * directory has been missing, regardless of `expire`.
 *
 * THE LOCK NEEDS AN UNLOCK, and this is the part that is easy to leave out. A
 * lock outlives its reason: a worktree locked onto a drive that was later
 * reformatted refuses to be removed, and `git worktree remove` fails on it
 * silently from the caller's point of view. Locking without a teardown path
 * trades a data-loss bug for a leak-forever bug, so `removeSessionWorktreeAsync`
 * unlocks first, unconditionally and best-effort.
 */

/**
 * ══ AND THE LOCK IS NOT ABOUT DRIVES AT ALL — issue #641 ══
 *
 * #630 locked worktrees on removable volumes and left the internal disk
 * unlocked, on the reasoning that a lock with no reason is the kind that
 * outlives its purpose. That reasoning was right about the risk and wrong about
 * the reason, because it only counted the risks that come from THIS engine.
 *
 * WHAT ACTUALLY DESTROYS THEM IS `gh`. Measured against gh 2.100.0's
 * `deleteLocalBranch` (`pkg/cmd/pr/merge/merge.go`): with `--delete-branch`, gh
 * reads `git worktree list --porcelain`, finds the worktree holding the PR's
 * head branch, and — when that worktree is a linked one other than the current
 * directory — runs `git worktree remove -- <path>` on it, then `git branch -D`.
 * The directory, the local branch and the registration all go in one command
 * nobody aimed at them.
 *
 * THAT IS NOT AN EDGE CASE HERE, IT IS THE HOUSE STYLE. A session is assigned a
 * feature, opens a PR for the first part, and the orchestrator merges it as soon
 * as CI passes — from somewhere else, which is precisely gh's "another linked
 * worktree" arm. The more promptly the PR is merged, the more reliably the
 * session's checkout is deleted out from under it.
 *
 * SO THE POLICY IS ABOUT THE SESSION, NOT THE DISK: a worktree belonging to a
 * session that is still live must not be removed, whatever happened to its
 * branch. A merged PR is not evidence the work is finished — only the person or
 * the session saying so is, and they say it by archiving or deleting the
 * session, which is the one path that unlocks.
 *
 * `git worktree lock` ENFORCES EXACTLY THAT, and it is the right instrument
 * rather than a convenient one: `worktree remove` refuses on a locked tree and
 * `--force` ONCE is not enough (git demands `-f -f`), which gh never passes;
 * `prune` ignores a locked tree however long its directory has been missing.
 * gh degrades to a warning and skips its local cleanup — the merge itself still
 * succeeds. Nothing a session does inside the tree is affected: commit, status,
 * push, fetch and `worktree repair` all behave identically under a lock.
 *
 * THE ONE THING A LOCK DOES BLOCK is `git worktree move`, which needs an unlock
 * first (or `-f -f`). Nothing in Telar moves a worktree that way today — the
 * store migration copies and then repairs, which is lock-transparent — but a
 * future relocate UI has to unlock, move and re-lock rather than discover this.
 *
 * The unlock in `removeSessionWorktreeAsync` was already unconditional, which is
 * what makes broadening the lock safe rather than a leak: see it below.
 */

/** Mount roots — where a removable volume appears. The fourth copy of this
 *  list, for the reason `volumes.ts`'s header gives: no app here imports
 *  another, and each says so. */
function isOnRemovableVolume(target: string, platform: NodeJS.Platform = process.platform): boolean {
  const roots = platform === "darwin" ? ["/Volumes"] : platform === "linux" ? ["/media", "/mnt"] : [];
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

/**
 * WHAT A HUMAN READS IN `git worktree list` AND IN GH'S REFUSAL, so the lock
 * explains itself at the moment it gets in somebody's way.
 *
 * TWO SENTENCES BECAUSE THERE ARE TWO REASONS and a worktree can have both. The
 * session sentence is the one that always applies; the volume sentence is
 * #630's and is added only where it is true, rather than folded into a single
 * vague reason that is half wrong in either case.
 */
export function worktreeLockReason(worktreePath: string, platform: NodeJS.Platform = process.platform): string {
  const session =
    "A Telar session is working in this worktree. Telar removes it when that session is archived or deleted — until then, removing it destroys work that is not finished.";
  return isOnRemovableVolume(worktreePath, platform)
    ? `${session} It also sits on a removable volume; unmounting that is not a deletion.`
    : session;
}

/**
 * Lock a session's worktree, so nothing outside Telar can decide it is finished.
 *
 * ALWAYS, NOT ONLY ON A REMOVABLE VOLUME — issue #641, and see this module's
 * header for what changed the reasoning. The short version: the thing that
 * actually deletes these is `gh pr merge --delete-branch`, which runs
 * `git worktree remove` on whichever linked worktree holds the merged branch,
 * and that has nothing to do with which disk it is on.
 *
 * BEST-EFFORT AND NEVER FATAL. A cut that succeeded must not be failed because
 * the lock did not take; the lock is a guard against a later removal, not a
 * precondition for the checkout being usable.
 */
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

/** Release a lock before teardown. Unconditional and best-effort: a worktree
 *  that was never locked answers non-zero and that is not a failure.
 *
 *  EXPORTED FOR THE MOVE (#642 part 2), which is the second caller and the
 *  reason this is no longer module-private: #641 locks every session worktree,
 *  and a locked worktree refuses `git worktree remove` — so relocating one has
 *  to take the lock off first, exactly as teardown does, and put it back on
 *  whichever path the checkout ends up at. */
export async function unlockWorktree(git: AsyncGitRunner, projectRoot: string, worktreePath: string): Promise<void> {
  try {
    await git(projectRoot, ["worktree", "unlock", worktreePath]);
  } catch {
    // Never locked, already unlocked, or a project that cannot answer.
  }
}

/**
 * REMOVE A CHECKOUT GIT NO LONGER KNOWS ABOUT — issue #671.
 *
 * WHY THIS IS NOT `git worktree remove`: because there is nothing to remove.
 * A directory whose registration was pruned — by a teardown whose `prune` ran
 * after the directory survived, by any other tool's `git worktree prune`, by a
 * repository that was re-cloned — is no longer a worktree in git's eyes. It is
 * a folder holding gigabytes that nothing will ever mention again, and asking
 * git to remove it produces "is not a working tree" and leaves the bytes.
 *
 * SO IT IS AN `rm`, AND AN `rm` NEEDS A FENCE. This is the one call in the
 * feature that deletes a directory without git's agreement, so it refuses
 * anything that is not a direct child of a root the engine itself manages. The
 * roots come from the inventory that found the directory, so the fence is the
 * same evidence the offer was made from — not a second opinion that could
 * differ from it.
 *
 * A DIRECT CHILD, NOT A DESCENDANT. `planSessionWorktree` puts every cut at
 * `<root>/<name>-<8hex>`, exactly one level down. Accepting a descendant would
 * let a path like `<root>/x/../../../..` pass a prefix test after resolution
 * tricks, and would make "remove this checkout" capable of removing something
 * inside one.
 *
 * IT FOLLOWS NO SYMLINK, for `measureStorage`'s reason turned around: a link
 * into somebody's project would make this a disk cleaner pointed at their work.
 */
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

/**
 * RE-POINT GIT AT A WORKTREE THAT MOVED — the other half of #630's migration.
 *
 * The two pointers are not symmetric, which is what makes moving a worktree by
 * copying it quietly wrong:
 *
 *   <worktree>/.git                      -> <repo>/.git/worktrees/<name>
 *   <repo>/.git/worktrees/<name>/gitdir  -> <worktree>/.git
 *
 * Moving the store rewrites neither. The first still resolves, because the
 * repository did not move; the second names a path that no longer exists, so
 * git believes the worktree was deleted. `git worktree repair`, given the new
 * path, rewrites it.
 *
 * IT IS RUN FROM THE REPOSITORY AND IS IDEMPOTENT, so a worktree that never
 * moved costs one `git` that changes nothing.
 */
export async function repairWorktree(git: AsyncGitRunner, projectRoot: string, worktreePath: string): Promise<boolean> {
  try {
    const repaired = await git(projectRoot, ["worktree", "repair", worktreePath]);
    return repaired.status === 0;
  } catch {
    return false;
  }
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
  /** Where checkouts go on THIS install (#642 part 2). Absent means the
   *  default beside the store, which is what every caller meant before the
   *  root could be chosen. Resolved by `prepareSessionWorktree`, which is also
   *  where an unusable one is refused. */
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

/**
 * EVERYTHING A CUT CAN BE REFUSED FOR, asked while the caller is still there.
 *
 * ONE PLACE, because there are now three callers — `createSession`, the browser
 * draft's promotion on first send, and the tests — and a refusal spelled three
 * times is a refusal that means three things by next year. What comes back is
 * what the background step needs and nothing else: where it lands, and what it
 * starts from.
 *
 * THROWS `WorktreeError` FOR ALL FIVE: a drive that is not connected, a
 * directory that is not a repository, a branch name outside what the engine will
 * create, a slug in the wrong shape, and a base ref that does not resolve. See
 * `isGitWorkTree` for why these stay on the request when the cut itself does not.
 *
 * THE DISK IS ASKED ABOUT FIRST, BEFORE ANY GIT — issue #534. An unplugged drive
 * used to reach `isGitWorkTree`, which found no repository there and said so:
 * "worktree sessions need a git repository; /Volumes/TelarVR/thing is not one.
 * Use envMode local for an unversioned project." Every word of that is wrong
 * about a repository that exists and is in somebody's bag, and the advice would
 * have put the session on a checkout that is not there either.
 *
 * THE CALLER PASSES WHAT IT ALREADY KNOWS rather than this probing again — the
 * store has just asked (`assertProjectAvailable`), and a second `stat` here
 * would be a second opinion that could differ from the one the refusal upstream
 * was based on. Absent means "not asked", which is what the tests and any caller
 * with no project record pass.
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
  /**
   * SIX REFUSALS NOW, AND THE NEW ONE IS THE CHECKOUTS' OWN DISK — #642 part 2.
   *
   * The five below are about the PROJECT. Once the checkouts can live on a
   * drive of their own, "can this session be cut" stops being answerable from
   * the project alone: the repository can be on the internal disk and perfectly
   * readable while the volume the checkout would land on is in somebody's bag.
   *
   * IT IS REFUSED FIRST, because it costs no git at all and because it is the
   * one refusal that is about this install rather than about this project —
   * every worktree session is blocked by it, so naming it before probing a
   * repository keeps the cheap answer cheap.
   */
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
  // THE PLAN'S OWN PARENT, not the configured root read a second time (#642
  // part 2). The plan was made against the root as it was when the request was
  // refused-or-accepted; re-reading here would let a root changed in between
  // create a directory the checkout is not going into.
  await fs.promises.mkdir(path.dirname(plan.path), { recursive: true, mode: 0o700 });

  // `-B` rather than `-b` FOR ENGINE-OWNED NAMES ONLY: a session recreated
  // after its worktree was reaped would otherwise fail forever on a branch
  // that still exists, and resetting inside `telar/`/`loom/` cannot clobber a
  // human's branch. A HUMAN-named branch takes `-b`: colliding with a branch
  // a person values must refuse, never reset.
  const added = await git(input.projectRoot, ["worktree", "add", plan.named ? "-b" : "-B", plan.branch, plan.path, baseSha]);
  if (added.status !== 0) {
    throw new WorktreeError(`git worktree add failed: ${added.stderr.trim() || added.stdout.trim()}`);
  }
  // LOCKED THE MOMENT IT EXISTS — #630 for the unmount, #641 for `gh pr merge
  // --delete-branch`. Before the cut returns, so there is no window in which
  // either could read as permission to delete it.
  await lockSessionWorktree(git, input.projectRoot, plan.path);
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
 *
 * AND NEITHER GIT COMMAND RUNS WHEN THE PROJECT'S DISK IS NOT THERE — issue
 * #534, and `prune` is the one that made this necessary. See this module's
 * header for the full argument; the short version is that `prune` is the only
 * operation here that DELETES git's own bookkeeping, it decides what to delete
 * by asking which worktree directories still exist, and a repository nobody can
 * read is not a repository anyone should be answering that question about.
 */
export async function removeSessionWorktreeAsync(
  git: AsyncGitRunner,
  projectRoot: string,
  worktreePath: string,
  availability?: ProjectAvailability,
): Promise<boolean> {
  if (availability !== undefined && availability !== "available") {
    // The directory is on the internal disk and is still the honest answer to
    // "is it gone" — it is not, because nothing removed it. A leaked worktree is
    // bounded inside the engine's root and reapable later; a pruned registration
    // is not recoverable at all.
    return !fs.existsSync(worktreePath);
  }
  /**
   * AND THE SAME REFUSAL FROM THE OTHER SIDE — issue #630.
   *
   * The check above asks whether the PROJECT is readable. Once the engine root
   * can be on a drive, that is no longer the same question as whether the
   * WORKTREE is: the project can be on the internal disk and perfectly
   * available while the worktrees are on a volume that is out. The guard would
   * pass, and `prune` would then delete the registration of every worktree on
   * the absent drive — not merely the one being removed.
   *
   * So the worktree's own root has to be there before anything prunes. The
   * lock (`lockSessionWorktree`) is what protects worktrees that already
   * exist; this is what stops us asking git the question at all.
   */
  const root = path.dirname(worktreePath);
  if (!fs.existsSync(root)) return false;
  // THIS UNLOCK IS THE WHOLE TEARDOWN PATH NOW — #641. Every session worktree is
  // locked at the cut, not just the ones on a drive, so this is the only door
  // out and it has to stay unconditional. Reaching here means a person or the
  // session asked for the session to go, which is the one authority the lock
  // defers to; a lock that outlives its reason is how "never lose one" becomes
  // "never remove one".
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
