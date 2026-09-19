/**
 * ══ MOVING THE CHECKOUTS THAT ARE ALREADY CUT — issue #642 part 2 ══
 *
 * IT RE-CUTS. IT DOES NOT COPY. That is the whole design, and it falls out of
 * the premise the feature rests on: **the commits were never in the worktree.**
 * A worktree is a checkout of a branch; the branch lives in the repository. So
 * moving one means removing it and adding it again at the new path, and the
 * work arrives at the same commit with the same files.
 *
 * WHY NOT COPY-AND-REPAIR, which is the obvious design and is wrong. Probed
 * against a real repository: a worktree has exactly ONE admin entry
 * (`<repo>/.git/worktrees/<name>`), and `git worktree repair <copy>` does not
 * add a second — it RE-POINTS the existing one at the copy. Both directories
 * then appear to work while sharing one index and one HEAD, so a commit made in
 * the original silently advances the copy. Trying to keep the old location safe
 * during the move is what creates that trapdoor, and a second registration of
 * the same branch is refused outright (`fatal: 'x' is already used by worktree
 * at ...`). There is no ordering of copy-and-repair that is safe.
 *
 * AND RE-CUTTING IS BETTER ON EVERY AXIS:
 *
 *   GIT ITSELF REFUSES TO LOSE UNCOMMITTED WORK. `git worktree remove` without
 *   `--force` fails on a dirty worktree — "contains modified or untracked
 *   files". That is the safety property this operation would otherwise have to
 *   hand-build, enforced by the tool, at exactly the right moment, per
 *   checkout. NOTHING HERE EVER PASSES `--force`.
 *
 *   NO SECOND COPY OF THE DISK. The person reaching for this is out of disk by
 *   definition; asking them to hold 12 GB twice at once is asking for the one
 *   thing they have not got.
 *
 *   NO ALIASING AT ANY INSTANT. Exactly one registration exists throughout, and
 *   it names exactly one directory.
 *
 * SO THE RULE IS STRONGER THAN "NOTHING DESTRUCTIVE BEFORE A VERIFIED COPY":
 * **nothing is removed that is not reproducible from a branch that still
 * exists.** Which has to be CHECKED rather than assumed — see `BRANCH_GONE`.
 */

import fs from "node:fs";
import path from "node:path";
import { lockSessionWorktree, unlockWorktree, type AsyncGitRunner } from "./worktree";

/** One checkout this engine knows about, as the caller sees it. */
export type Checkout = {
  sessionId: string;
  /** Where it is now — the path recorded on the session, never recomputed. */
  path: string;
  branch: string;
  projectRoot: string;
  /** Anything but `idle`. A checkout under a session that is doing something
   *  is not moved, and its presence refuses the whole operation. */
  busy: boolean;
};

/**
 * WHY ONE CHECKOUT WAS LEFT WHERE IT IS. Separate reasons rather than one
 * "could not move it", because they send a person to different places: commit
 * your work, versus a branch that no longer exists, versus git said something
 * nobody predicted. Merging them would make the message useless at the moment
 * it is needed.
 */
export type SkipReason =
  /** Uncommitted or untracked files. Git refused, and we never force. */
  | "dirty"
  /**
   * THE HOLE IN "REPRODUCIBLE FROM A BRANCH", AND IT IS A REAL ONE. #641
   * established that `gh pr merge --delete-branch` destroys the local branch
   * as well as the remote. A session whose PR was merged before that fix may
   * hold a checkout whose branch is gone from both — and under re-cutting that
   * is unrecoverable: `remove` would succeed and `add` would have nothing to
   * check out. So the branch is verified BEFORE anything is removed.
   *
   * GIT NARROWS THIS BY ITSELF, but does not close it. `git branch -D` refuses
   * a branch a REGISTERED worktree is using, so a merge cannot strand a live
   * registration. What #641 produced is the other order — the worktree was
   * destroyed and pruned first, and the branch went afterwards — which leaves
   * a session record naming a checkout and a branch that are both gone. The
   * check is cheap and that state is what it is for.
   */
  | "branch-gone"
  /** No branch at all — a detached checkout has no handle to re-cut from. */
  | "detached"
  /** Git refused the re-add for a reason this does not model. The checkout was
   *  put back where it was. */
  | "failed";

export type MoveOutcome = {
  moved: Array<{ sessionId: string; from: string; to: string }>;
  skipped: Array<{ sessionId: string; path: string; reason: SkipReason; detail?: string }>;
};

/** The whole operation is refused rather than half-run. */
export class WorktreeMoveError extends Error {}

/** Git's own words when it will not remove a dirty checkout. Matched loosely:
 *  the point is to tell "the person has work here" from "something else went
 *  wrong", and only the first is a reason to say "commit it first". */
function refusedForChanges(message: string): boolean {
  return /modified or untracked files|contains modified/i.test(message);
}

/**
 * MOVE WHAT CAN BE MOVED, AND NAME WHAT CANNOT.
 *
 * REFUSED WHOLESALE IF ANYTHING IS BUSY, before a single checkout is touched.
 * "A half-migrated worktrees root loses uncommitted work in every open
 * session", and a session with a turn in flight is that sentence even when
 * every git command succeeds — the agent is holding that directory as its
 * working directory right now.
 *
 * PARTIAL IS SAFE HERE, unlike in a copy-based move, and that is worth saying
 * because it looks like the thing we refused. Each checkout is independent: its
 * own `remove`, its own `add`, its own state rewrite. One skipped for dirt
 * changes nothing about the others, and the operation is re-runnable — somebody
 * who commits their work presses it again and moves the rest.
 *
 * `onMoved` IS THE COMMIT POINT FOR ONE CHECKOUT and runs immediately after its
 * `add` returns 0, so the window in which the session record names a path that
 * no longer exists is one synchronous call wide. It is not zero, because git's
 * registration and the engine's record are two places; what makes that
 * survivable is that the branch still exists throughout, so the checkout is
 * re-cuttable from either end.
 */
export async function moveCheckouts(
  git: AsyncGitRunner,
  input: {
    checkouts: readonly Checkout[];
    destination: string;
    /** Rewrite the session's recorded path. Called once per moved checkout. */
    onMoved: (sessionId: string, to: string) => void;
  },
): Promise<MoveOutcome> {
  const busy = input.checkouts.filter((checkout) => checkout.busy);
  if (busy.length > 0) {
    throw new WorktreeMoveError(
      busy.length === 1
        ? "One session is still working in its checkout. Moving it now would pull the folder out from under a turn that is running — wait for it to finish, then try again."
        : `${busy.length} sessions are still working in their checkouts. Moving them now would pull the folders out from under turns that are running — wait for them to finish, then try again.`,
    );
  }

  const destination = path.resolve(input.destination);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });

  const outcome: MoveOutcome = { moved: [], skipped: [] };
  for (const checkout of input.checkouts) {
    /**
     * ALREADY THERE IS NOT WORK — and it is not a skip either, because nothing
     * is wrong with it. Without this, a second run removes and re-cuts every
     * checkout in place: minutes of git, and a destroy-and-recreate of work
     * that was exactly where it belonged. The operation is meant to be
     * re-runnable after somebody commits, so the second press has to be cheap.
     */
    if (path.dirname(path.resolve(checkout.path)) === destination) continue;
    if (!checkout.branch) {
      outcome.skipped.push({ sessionId: checkout.sessionId, path: checkout.path, reason: "detached" });
      continue;
    }
    /**
     * THE BRANCH, BEFORE ANYTHING IS REMOVED. This is the load-bearing half of
     * "nothing is removed that is not reproducible from a branch that still
     * exists" — checked, never assumed. See `branch-gone`.
     */
    const resolved = await git(checkout.projectRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${checkout.branch}`]);
    if (resolved.status !== 0 || !resolved.stdout.trim()) {
      outcome.skipped.push({ sessionId: checkout.sessionId, path: checkout.path, reason: "branch-gone", detail: checkout.branch });
      continue;
    }

    /**
     * UNLOCK FIRST — issue #641 made every session worktree locked, not just
     * the ones on a removable volume, precisely so that nothing outside Telar
     * (`gh pr merge --delete-branch`) can decide a live checkout is finished.
     * A locked worktree refuses `git worktree remove`, so this operation has
     * to take its own lock off before it can move anything.
     *
     * UNCONDITIONAL AND BEST-EFFORT, the way `removeSessionWorktreeAsync` does
     * it: a worktree that was never locked answers non-zero and that is not a
     * failure.
     *
     * AND EVERY PATH BELOW PUTS THE LOCK BACK. An unlocked checkout left
     * behind by a move that did not happen is #641 re-opened, quietly, for
     * exactly the sessions somebody just tried to tidy up.
     */
    await unlockWorktree(git, checkout.projectRoot, checkout.path);

    // NEVER `--force`. A refusal here is git protecting somebody's uncommitted
    // work, and overriding it is the one thing this operation must not do.
    const removed = await git(checkout.projectRoot, ["worktree", "remove", checkout.path]);
    if (removed.status !== 0) {
      const message = (removed.stderr || removed.stdout).trim();
      // It stays where it is, so it goes back under #641's protection.
      await lockSessionWorktree(git, checkout.projectRoot, checkout.path);
      outcome.skipped.push({
        sessionId: checkout.sessionId,
        path: checkout.path,
        reason: refusedForChanges(message) ? "dirty" : "failed",
        ...(message ? { detail: message } : {}),
      });
      continue;
    }

    const target = path.join(destination, path.basename(checkout.path));
    const added = await git(checkout.projectRoot, ["worktree", "add", target, checkout.branch]);
    if (added.status !== 0) {
      /**
       * PUT IT BACK. The checkout is gone from disk and its branch is intact,
       * so re-cutting it where it was costs one command and leaves the session
       * exactly as it started — which is the difference between a failed move
       * and a lost checkout.
       */
      const restored = await git(checkout.projectRoot, ["worktree", "add", checkout.path, checkout.branch]);
      // Back where it started means back under its lock (#641).
      if (restored.status === 0) await lockSessionWorktree(git, checkout.projectRoot, checkout.path);
      outcome.skipped.push({
        sessionId: checkout.sessionId,
        path: checkout.path,
        reason: "failed",
        detail:
          restored.status === 0
            ? (added.stderr || added.stdout).trim() || "git would not make the checkout in the new location"
            : `${(added.stderr || added.stdout).trim()} — and it could not be put back at ${checkout.path}; the branch ${checkout.branch} still has the work`,
      });
      continue;
    }

    /**
     * THE LOCK FOLLOWS THE CHECKOUT (#641). It is a property of the session
     * still working in it, not of where it happens to sit, so a moved checkout
     * that arrived unlocked would be one `gh pr merge` away from the bug #641
     * closed — and it would be unlocked precisely for the sessions somebody
     * had just taken the trouble to relocate.
     */
    await lockSessionWorktree(git, checkout.projectRoot, target);
    input.onMoved(checkout.sessionId, target);
    outcome.moved.push({ sessionId: checkout.sessionId, from: checkout.path, to: target });
  }
  return outcome;
}

/** What a person is told afterwards, per reason rather than as one total — a
 *  checkout left behind for uncommitted work and one left behind because its
 *  branch is gone send them to two different places. */
export function describeOutcome(outcome: MoveOutcome): string {
  const parts: string[] = [];
  if (outcome.moved.length > 0) parts.push(`Moved ${outcome.moved.length} checkout${outcome.moved.length === 1 ? "" : "s"}.`);
  const count = (reason: SkipReason) => outcome.skipped.filter((entry) => entry.reason === reason).length;
  const dirty = count("dirty");
  const gone = count("branch-gone");
  const detached = count("detached");
  const failed = count("failed");
  if (dirty > 0) parts.push(`${dirty} ${dirty === 1 ? "has" : "have"} uncommitted changes and stayed put — commit them and run this again.`);
  if (gone > 0) parts.push(`${gone} ${gone === 1 ? "has a branch that" : "have branches that"} no longer exist, so ${gone === 1 ? "it" : "they"} could not be re-cut and stayed put.`);
  if (detached > 0) parts.push(`${detached} ${detached === 1 ? "is" : "are"} not on a branch and stayed put.`);
  if (failed > 0) parts.push(`${failed} could not be moved and ${failed === 1 ? "was" : "were"} left where ${failed === 1 ? "it was" : "they were"}.`);
  if (parts.length === 0) return "There was nothing to move.";
  return parts.join(" ");
}
