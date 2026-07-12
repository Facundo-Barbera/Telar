// M3 — consolidation-on-completion. The branch-gather logic kept out of
// weave.ts/executor.ts so it stays slim and this is independently unit-tested.
//
// MOAT: consolidation only ever commits onto the loom's own `telar/<rootId>`
// review branch — never `baseBranch`, never a fast-forward/merge into the
// checked-out tree, never a state change. It gathers every `done` child's diff
// into ONE branch (the human-review DELIVERABLE) and finalizes at rollup →
// `ready`. Landing that branch stays the human `acceptLoom` click.
import type { Loom } from "./looms";
import {
  defaultGitRunner,
  foldThreadIntoBranch,
  type GitRunner,
} from "./vcs";

// Fold ONE completed child thread's work onto the root's consolidation branch,
// before that thread's ephemeral worktree is removed. Disjoint allowedPaths
// across subgoals make the copy conflict-free by construction (same guarantee
// as the build fan-out); an out-of-scope file the builder touched is recorded
// as `stray` and NOT copied — the #55 no-sweep protection at the worktree
// layer. An empty allowedPaths list means "fold the whole isolated-worktree
// diff" (the worktree started clean at the pinned base, so its entire diff IS
// the thread's work — there is nothing unrelated to sweep).
export async function foldChildOnDone(args: {
  child: Loom;
  root: Loom;
  repoRoot: string;
  allowedPaths: string[];
  git?: GitRunner;
}): Promise<{ merged: string[]; stray: string[]; collisions: string[] }> {
  const git = args.git ?? defaultGitRunner;
  const { child, root, repoRoot } = args;
  if (!root.consolidationBranch) throw new Error("foldChildOnDone: root has no consolidationBranch");
  if (!child.worktree) throw new Error("foldChildOnDone: child has no worktree");
  const allowed = args.allowedPaths.length ? args.allowedPaths : [""]; // [""] => allow all (globBase "" matches everything)
  const message = `feat(thread): ${child.title}\n\nThread: ${child.id}\nSubgoal: ${child.subGoalId ?? ""}`;
  // Pass the root's pinned base so the fold can flag a same-file collision with a
  // prior thread (surfaced by the caller) instead of silently last-write-wins.
  return foldThreadIntoBranch(git, repoRoot, root.consolidationBranch, child.worktree, allowed, message, root.baseSha);
}

// Finalize the review branch at rollup → `ready`: count the commits that landed
// on it (relative to the pinned base). If ZERO children folded, drop the empty
// branch and unset root.consolidationBranch so there is no dangling empty
// deliverable. Otherwise leave the branch (the deliverable) in place. Never
// merges, never checks out baseBranch, never changes loom.state — the caller
// records the `consolidated` event and persists.
export function finalizeConsolidation(
  root: Loom,
  repoRoot: string,
  git: GitRunner = defaultGitRunner,
): { commits: number; dropped: boolean } {
  const branch = root.consolidationBranch;
  if (!branch) return { commits: 0, dropped: false };

  let commits = 0;
  if (root.baseSha) {
    const r = git(repoRoot, ["rev-list", "--count", `${root.baseSha}..${branch}`]);
    if (r.status === 0) commits = parseInt(r.stdout.trim() || "0", 10) || 0;
  } else {
    // No pinned base to diff against — fall back to any commits reachable from
    // the branch that aren't on the checked-out HEAD.
    const r = git(repoRoot, ["rev-list", "--count", `HEAD..${branch}`]);
    if (r.status === 0) commits = parseInt(r.stdout.trim() || "0", 10) || 0;
  }

  if (commits === 0) {
    git(repoRoot, ["branch", "-D", branch]);
    root.consolidationBranch = undefined;
    return { commits: 0, dropped: true };
  }
  return { commits, dropped: false };
}
