/**
 * A READ-ONLY view of a project's git state.
 *
 * WHY THE ENGINE OWNS THIS. The composer's foot states which project and which
 * branch the next message will act on — it is the answer to "where does this
 * land", asked at the moment a person presses Enter. A browser cannot run `git`,
 * and the engine already holds the project root and an injectable runner for it
 * (see ./worktree.ts), so this is the only party that can answer.
 *
 * EVERY CALL IS READ-ONLY, and that is a boundary rather than an accident. This
 * module runs `rev-parse`, `status --porcelain`, `rev-list` and `worktree list`
 * and nothing else. A mutation belongs behind a request a human answers, not
 * behind a panel that refreshes itself every fifteen seconds.
 *
 * A PROJECT THAT IS NOT A REPOSITORY IS NOT AN ERROR. `envMode: "local"` exists
 * precisely so an unversioned directory can host sessions, so the overview
 * reports `repository: false` and stops. Throwing here would make the composer's
 * foot a failure state for a configuration the engine supports on purpose.
 */
import type { GitRunner } from "./worktree.js";

export type GitWorktreeEntry = {
  path: string;
  /** The last path segment — what a human calls the checkout. */
  basename: string;
  branch?: string;
  /** The project root itself, as opposed to a session's cut worktree. */
  isMainCheckout: boolean;
};

export type GitOverview = {
  repository: boolean;
  branch?: string;
  /** Paths with staged, unstaged or untracked changes. */
  dirtyFiles: number;
  /** Commits this branch has that its upstream does not, and vice versa.
   *  Both absent when there is no upstream — which is not the same as zero. */
  ahead?: number;
  behind?: number;
  worktrees: GitWorktreeEntry[];
};

const EMPTY: GitOverview = { repository: false, dirtyFiles: 0, worktrees: [] };

function basenameOf(target: string): string {
  const parts = target.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? target;
}

/**
 * Whether two paths name the same directory.
 *
 * NOT `===`, and this is not hypothetical. A project registered as
 * `/Users/x/Projects/personal/telar-vnext` and a `git worktree list` reporting
 * `/Users/x/Projects/Personal/telar-vnext` are the same directory on macOS, and
 * a strict comparison marked the project's own checkout as somebody else's
 * worktree — so the environment popover reported "0 worktrees" while standing
 * in one. Found by running it against a real repository.
 *
 * Case folding is applied only where the platform actually folds case; on Linux
 * those two paths are genuinely different directories and must stay so.
 */
const CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";

export function samePath(left: string, right: string, caseInsensitive = CASE_INSENSITIVE_FS): boolean {
  const normalise = (value: string) => {
    const unified = value.replace(/\\/g, "/").replace(/\/+$/, "");
    return caseInsensitive ? unified.toLowerCase() : unified;
  };
  return normalise(left) === normalise(right);
}

/**
 * `git worktree list --porcelain` emits stanzas separated by blank lines:
 *
 *     worktree /abs/path
 *     HEAD <sha>
 *     branch refs/heads/main
 *
 * A detached worktree has `detached` in place of `branch`, so `branch` stays
 * undefined rather than being invented — a checkout with no branch is a real
 * state and naming it "HEAD" would hide it.
 */
export function parseWorktreeList(stdout: string, projectRoot: string): GitWorktreeEntry[] {
  const entries: GitWorktreeEntry[] = [];
  let current: { path?: string; branch?: string } = {};
  const flush = () => {
    if (!current.path) return;
    entries.push({
      path: current.path,
      basename: basenameOf(current.path),
      ...(current.branch ? { branch: current.branch } : {}),
      isMainCheckout: samePath(current.path, projectRoot),
    });
    current = {};
  };

  for (const line of stdout.split("\n")) {
    const value = line.trim();
    if (!value) {
      flush();
      continue;
    }
    if (value.startsWith("worktree ")) {
      // A stanza can begin without a blank line before it on some git versions.
      flush();
      current.path = value.slice("worktree ".length).trim();
    } else if (value.startsWith("branch ")) {
      current.branch = value.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    }
  }
  flush();
  return entries;
}

/** `A  file`, `?? file`, ` M file` — one path per line, so the count is lines. */
export function countDirty(stdout: string): number {
  return stdout.split("\n").filter((line) => line.trim().length > 0).length;
}

/** `git rev-list --left-right --count @{upstream}...HEAD` → "behind\tahead". */
export function parseAheadBehind(stdout: string): { ahead: number; behind: number } | undefined {
  const parts = stdout.trim().split(/\s+/);
  if (parts.length < 2) return undefined;
  const behind = Number(parts[0]);
  const ahead = Number(parts[1]);
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return undefined;
  return { ahead, behind };
}

export function gitOverview(git: GitRunner, projectRoot: string): GitOverview {
  const inside = git(projectRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.status !== 0 || inside.stdout.trim() !== "true") return EMPTY;

  // `--abbrev-ref HEAD` gives "HEAD" on a detached checkout; that is a real
  // state and reporting it as a branch name would be a lie, so it is dropped.
  const head = git(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const raw = head.status === 0 ? head.stdout.trim() : "";
  const branch = raw && raw !== "HEAD" ? raw : undefined;

  const status = git(projectRoot, ["status", "--porcelain"]);
  const dirtyFiles = status.status === 0 ? countDirty(status.stdout) : 0;

  // No upstream is the common case for a fresh branch and is NOT an error —
  // git exits non-zero and both figures stay absent rather than becoming 0.
  const tracking = git(projectRoot, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
  const divergence = tracking.status === 0 ? parseAheadBehind(tracking.stdout) : undefined;

  const worktrees = git(projectRoot, ["worktree", "list", "--porcelain"]);

  return {
    repository: true,
    ...(branch ? { branch } : {}),
    dirtyFiles,
    ...(divergence ?? {}),
    worktrees: worktrees.status === 0 ? parseWorktreeList(worktrees.stdout, projectRoot) : [],
  };
}
