// Moves re-cut (remove, then add at the new path) rather than copy: repair re-points the single admin entry,
// so a copy would alias the original. Nothing ever passes --force, and nothing is removed unless its branch
// still exists.

import fs from "node:fs";
import path from "node:path";
import { lockSessionWorktree, unlockWorktree } from "./checkout";
import { type AsyncGitRunner } from "../../platform/git/runner";

/** One checkout this engine knows about, as the caller sees it. */
export type Checkout = {
  sessionId: string;
  /** Where it is now — the path recorded on the session, never recomputed. */
  path: string;
  branch: string;
  projectRoot: string;
  /** Anything but `idle`: a turn is running in it, so it is not moved. */
  busy: boolean;
};

type SkipReason =
  | "busy"
  /** Uncommitted or untracked files. Git refused, and we never force. */
  | "dirty"
  // The local branch is gone too (an old `gh pr merge --delete-branch`), so a re-cut would have nothing to add.
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

/** Git's own words when it will not remove a dirty checkout. Matched loosely:
 *  the point is to tell "the person has work here" from "something else went
 *  wrong", and only the first is a reason to say "commit it first". */
function refusedForChanges(message: string): boolean {
  return /modified or untracked files|contains modified/i.test(message);
}

// A busy session's checkout stays put. Each checkout moves on its own, so a partial move is safe
// and re-runnable; `onMoved` runs right after its add succeeds.
export async function moveCheckouts(
  git: AsyncGitRunner,
  input: {
    checkouts: readonly Checkout[];
    destination: string;
    /** Rewrite the session's recorded path. Called once per moved checkout. */
    onMoved: (sessionId: string, to: string) => void;
  },
): Promise<MoveOutcome> {
  const destination = path.resolve(input.destination);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });

  const outcome: MoveOutcome = { moved: [], skipped: [] };
  for (const checkout of input.checkouts) {
    // Already at the destination: skip, so a second press is cheap.
    if (path.dirname(path.resolve(checkout.path)) === destination) continue;
    if (checkout.busy) {
      outcome.skipped.push({ sessionId: checkout.sessionId, path: checkout.path, reason: "busy" });
      continue;
    }
    if (!checkout.branch) {
      outcome.skipped.push({ sessionId: checkout.sessionId, path: checkout.path, reason: "detached" });
      continue;
    }
    const resolved = await git(checkout.projectRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${checkout.branch}`]);
    if (resolved.status !== 0 || !resolved.stdout.trim()) {
      outcome.skipped.push({ sessionId: checkout.sessionId, path: checkout.path, reason: "branch-gone", detail: checkout.branch });
      continue;
    }

    // Session worktrees are locked against outside removal; every path below puts the lock back.
    await unlockWorktree(git, checkout.projectRoot, checkout.path);

    // NEVER `--force`. A refusal here is git protecting somebody's uncommitted
    // work, and overriding it is the one thing this operation must not do.
    const removed = await git(checkout.projectRoot, ["worktree", "remove", checkout.path]);
    if (removed.status !== 0) {
      const message = (removed.stderr || removed.stdout).trim();
      // It stays where it is, so it goes back under its lock.
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
      // Put it back where it was; its branch is intact.
      const restored = await git(checkout.projectRoot, ["worktree", "add", checkout.path, checkout.branch]);
      // Back where it started means back under its lock.
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
  const busy = count("busy");
  const dirty = count("dirty");
  const gone = count("branch-gone");
  const detached = count("detached");
  const failed = count("failed");
  if (busy > 0) parts.push(`${busy} ${busy === 1 ? "has a turn" : "have turns"} running and stayed put — run this again when ${busy === 1 ? "it finishes" : "they finish"}.`);
  if (dirty > 0) parts.push(`${dirty} ${dirty === 1 ? "has" : "have"} uncommitted changes and stayed put — commit them and run this again.`);
  if (gone > 0) parts.push(`${gone} ${gone === 1 ? "has a branch that" : "have branches that"} no longer exist, so ${gone === 1 ? "it" : "they"} could not be re-cut and stayed put.`);
  if (detached > 0) parts.push(`${detached} ${detached === 1 ? "is" : "are"} not on a branch and stayed put.`);
  if (failed > 0) parts.push(`${failed} could not be moved and ${failed === 1 ? "was" : "were"} left where ${failed === 1 ? "it was" : "they were"}.`);
  if (parts.length === 0) return "There was nothing to move.";
  return parts.join(" ");
}
