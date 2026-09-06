/**
 * A READ-ONLY view of a project's git state.
 *
 * WHY THE ENGINE OWNS THIS. The composer's foot states which project and which
 * branch the next message will act on — it is the answer to "where does this
 * land", asked at the moment a person presses Enter. A browser cannot run `git`,
 * and the engine already holds the project root and an injectable runner for it
 * (see ./worktree.ts), so this is the only party that can answer.
 *
 * EVERY READ IS READ-ONLY, and that is still the boundary: `gitOverview` and
 * `sessionDiff` run `rev-parse`, `status`, `diff`, `log`, `rev-list` and
 * `worktree list`, and a surface that refreshes itself on a timer may call
 * nothing else.
 *
 * THERE IS EXACTLY ONE MUTATION, `commitSessionWork`, and its shape is the rule
 * for any that follow: a human pressed a button, it is additive, and it is
 * recoverable. `git commit` can be undone with a reset; `git restore`,
 * `git checkout <branch>` and a hunk-level index cannot, and a panel that
 * refreshes every fifteen seconds beside an agent that is still writing is the
 * worst possible place to offer them. The frozen cockpit offered all three (see
 * `apps/web_old/components/session/workspace-git-pane.tsx`): a branch list whose
 * rows ran `git checkout` in the tree an agent was working in, with no
 * confirmation. Their absence here is a decision, not a gap.
 *
 * A PROJECT THAT IS NOT A REPOSITORY IS NOT AN ERROR. `envMode: "local"` exists
 * precisely so an unversioned directory can host sessions, so the overview
 * reports `repository: false` and stops. Throwing here would make the composer's
 * foot a failure state for a configuration the engine supports on purpose.
 */
import type { GitChangeStatus, GitCommitEntry, GitFileChange, SessionDiff } from "@telar/engine-client";
import type { AsyncGitRunner, GitRunner } from "./worktree.js";

export type GitWorktreeEntry = {
  path: string;
  /** The last path segment — what a human calls the checkout. */
  basename: string;
  branch?: string;
  /** The project root itself, as opposed to a session's cut worktree. */
  isMainCheckout: boolean;
};

export type GitRefEntry = {
  /** Short name, remote-qualified for remotes (`origin/main`) — resolvable
   *  verbatim as a worktree base. */
  name: string;
  kind: "local" | "remote";
  /** The checkout's current branch. Local only. */
  head?: boolean;
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
  /** Cuttable bases, newest commit first, capped. Absent on a non-repository. */
  refs?: GitRefEntry[];
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

/**
 * How many changed files one review may carry.
 *
 * A HUMAN LIMIT, NOT A TRANSPORT ONE. Past a couple of hundred rows nobody is
 * reading a list — they are looking for a number and a shape — and a session
 * that touched 4,000 files (a `node_modules` that escaped a gitignore, a
 * formatter run over the repo) would otherwise turn a panel poll into a
 * megabyte. `truncated` is reported so the surface can say what it dropped.
 */
const MAX_REVIEW_FILES = 300;

/** Splits a NUL-delimited git payload, dropping the trailing empty field. */
export function nulFields(stdout: string): string[] {
  const fields = stdout.split("\0");
  if (fields.at(-1) === "") fields.pop();
  return fields;
}

/**
 * `git diff -z --numstat` → adds, dels, path — with renames arriving as THREE
 * fields rather than one.
 *
 * `-z` is what makes this parseable at all. Without it a rename prints as
 * `src/{old => new}/file.ts`, a brace form that has to be reassembled by hand
 * and that silently mis-parses any real path containing a brace. With `-z` the
 * counts stay tab-separated and the paths become separate NUL fields, so there
 * is nothing to guess. A binary file reports `-` for both counts, which is
 * ABSENT rather than zero.
 */
export function parseNumstat(stdout: string): { path: string; renamedFrom?: string; added?: number; removed?: number; binary: boolean }[] {
  const out: { path: string; renamedFrom?: string; added?: number; removed?: number; binary: boolean }[] = [];
  const fields = nulFields(stdout);
  for (let index = 0; index < fields.length; index += 1) {
    const head = fields[index]!;
    const parts = head.split("\t");
    if (parts.length < 3) continue;
    const [added, removed, first] = parts as [string, string, string];
    const binary = added === "-" || removed === "-";
    // An empty third field means the paths follow as their own records, which is
    // how `-z` reports a rename or a copy.
    let path = first;
    let renamedFrom: string | undefined;
    if (first === "") {
      renamedFrom = fields[index + 1];
      path = fields[index + 2] ?? "";
      index += 2;
    }
    if (!path) continue;
    out.push({
      path,
      ...(renamedFrom ? { renamedFrom } : {}),
      ...(binary ? {} : { added: Number(added), removed: Number(removed) }),
      binary,
    });
  }
  return out;
}

const NAME_STATUS: Record<string, GitChangeStatus> = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "added", T: "modified" };

/** `git diff -z --name-status` → one status letter per path, same NUL rules. */
export function parseNameStatus(stdout: string): Map<string, GitChangeStatus> {
  const out = new Map<string, GitChangeStatus>();
  const fields = nulFields(stdout);
  for (let index = 0; index < fields.length; index += 1) {
    const code = fields[index]!;
    const letter = code[0];
    if (!letter || !NAME_STATUS[letter]) continue;
    // R100 / C75 carry a similarity score and two paths; the NEW path is the
    // one the row is about.
    const renamed = letter === "R" || letter === "C";
    const path = renamed ? fields[index + 2] : fields[index + 1];
    index += renamed ? 2 : 1;
    if (path) out.set(path, NAME_STATUS[letter]!);
  }
  return out;
}

/** `git status --porcelain -z` → the untracked paths only. Everything tracked is
 *  already in the base diff, and reading it twice would double the row. */
export function parseUntracked(stdout: string): string[] {
  return nulFields(stdout)
    .filter((entry) => entry.startsWith("?? "))
    .map((entry) => entry.slice(3))
    .filter(Boolean);
}

/** Field and record separators chosen because git will not emit them itself:
 *  a commit subject may contain any printable character, including tabs. */
const FIELD = "";
const RECORD = "";
export const GIT_LOG_FORMAT = `%H${FIELD}%h${FIELD}%s${FIELD}%at${FIELD}%an${RECORD}`;

export function parseGitLog(stdout: string): GitCommitEntry[] {
  return stdout
    .split(RECORD)
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record.trim().length > 0)
    .flatMap((record) => {
      const [sha, shortSha, subject, at, author] = record.split(FIELD);
      if (!sha || !shortSha) return [];
      const seconds = Number(at);
      return [
        {
          sha,
          shortSha,
          subject: subject ?? "",
          // Seconds at the seam, milliseconds everywhere else — converted once
          // here rather than by every client that renders a date.
          at: Number.isFinite(seconds) ? seconds * 1000 : 0,
          author: author ?? "",
        },
      ];
    });
}

/**
 * What a session has done to the repository, from where it started to now.
 *
 * RUN IN THE SESSION'S OWN CHECKOUT. `cwd` is the session workspace, not the
 * project root: a worktree session has its own branch and its own working tree,
 * and describing the project root instead would report changes belonging to
 * whoever else is working there.
 *
 * `base` ABSENT IS A DIFFERENT QUESTION, answered honestly rather than papered
 * over. With a base this is `base…worktree` and includes the agent's own
 * commits; without one it is `HEAD…worktree` and cannot. The caller reports
 * which, so a session created before bases were recorded does not silently
 * claim its committed work never happened.
 */
export function sessionDiff(git: GitRunner, input: { cwd: string; baseRef?: string }): SessionDiff {
  const { cwd, baseRef } = input;
  const inside = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.status !== 0 || inside.stdout.trim() !== "true") {
    return { repository: false, workspacePath: cwd, files: [], commits: [], linesAdded: 0, linesRemoved: 0, truncated: false };
  }

  const head = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const raw = head.status === 0 ? head.stdout.trim() : "";
  const branch = raw && raw !== "HEAD" ? raw : undefined;

  /**
   * A BASE THAT NO LONGER RESOLVES IS DROPPED, not reported.
   *
   * A worktree's base commit can genuinely disappear — a rebase upstream, a
   * `gc` after a branch was deleted — and every command below would then fail
   * with the same opaque "bad revision". Falling back to HEAD gives a smaller
   * true answer instead of an error a reader cannot act on.
   */
  const resolved = baseRef && git(cwd, ["rev-parse", "--verify", "--quiet", baseRef]).status === 0 ? baseRef : undefined;
  const against = resolved ?? "HEAD";

  const numstat = git(cwd, ["diff", "-z", "--numstat", "--find-renames", against, "--"]);
  const nameStatus = git(cwd, ["diff", "-z", "--name-status", "--find-renames", against, "--"]);
  const statuses = nameStatus.status === 0 ? parseNameStatus(nameStatus.stdout) : new Map<string, GitChangeStatus>();
  const tracked: GitFileChange[] = (numstat.status === 0 ? parseNumstat(numstat.stdout) : []).map((entry) => ({
    path: entry.path,
    status: statuses.get(entry.path) ?? "modified",
    ...(entry.renamedFrom ? { renamedFrom: entry.renamedFrom } : {}),
    ...(entry.added === undefined ? {} : { linesAdded: entry.added }),
    ...(entry.removed === undefined ? {} : { linesRemoved: entry.removed }),
    ...(entry.binary ? { binary: true } : {}),
  }));

  // Untracked files are NOT in `git diff` at all, so a review built from the
  // diff alone would miss every file the agent created and never staged —
  // which for a scaffolding run is all of them.
  /**
   * `-uall` IS LOAD-BEARING. By default `git status` collapses a wholly
   * untracked directory into ONE entry with a trailing slash — `dist/` — which
   * is a row a reviewer cannot open, cannot count, and cannot judge. Found by
   * running this against a real repository: five new files under two new
   * directories arrived as two directory rows. Listing files individually is
   * what makes the review a review; the file cap and `truncated` handle the
   * pathological case of an unignored `node_modules`.
   */
  const status = git(cwd, ["status", "--porcelain", "-z", "-uall"]);
  const untracked: GitFileChange[] = (status.status === 0 ? parseUntracked(status.stdout) : []).map((path) => ({
    path,
    status: "untracked" as const,
  }));

  const log = resolved ? git(cwd, ["log", `--format=${GIT_LOG_FORMAT}`, `${resolved}..HEAD`]) : undefined;
  const commits = log?.status === 0 ? parseGitLog(log.stdout) : [];

  const tracking = git(cwd, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
  const divergence = tracking.status === 0 ? parseAheadBehind(tracking.stdout) : undefined;

  const all = [...tracked, ...untracked].sort((left, right) => left.path.localeCompare(right.path));
  return {
    repository: true,
    workspacePath: cwd,
    ...(branch ? { branch } : {}),
    ...(resolved ? { base: resolved } : {}),
    ...(divergence ?? {}),
    files: all.slice(0, MAX_REVIEW_FILES),
    commits,
    // Totalled over EVERY file, not just the ones that survived the cap: the
    // headline figure must describe the change, and the list is what is capped.
    linesAdded: all.reduce((sum, file) => sum + (file.linesAdded ?? 0), 0),
    linesRemoved: all.reduce((sum, file) => sum + (file.linesRemoved ?? 0), 0),
    truncated: all.length > MAX_REVIEW_FILES,
  };
}

/**
 * One file's patch, on demand.
 *
 * NOT INLINED IN `sessionDiff`, for the same reason the browser's screenshot is
 * not journalled: a review of two hundred files carrying every patch is a
 * megabyte on a poll, and the reader opens one row at a time.
 *
 * An UNTRACKED file has no diff — git will not compare it to anything — so it is
 * diffed against `/dev/null` explicitly. `--no-index` exits 1 when the files
 * differ, which is the successful case here and the reason this accepts 1.
 */
export function sessionFilePatch(
  git: GitRunner,
  input: { cwd: string; baseRef?: string; path: string; untracked?: boolean },
): { patch: string; binary: boolean } {
  const { cwd, baseRef, path: target } = input;
  const against = baseRef && git(cwd, ["rev-parse", "--verify", "--quiet", baseRef]).status === 0 ? baseRef : "HEAD";
  const result = input.untracked
    ? git(cwd, ["diff", "--no-index", "--unified=3", "--", "/dev/null", target])
    : git(cwd, ["diff", "--unified=3", against, "--", target]);
  if (result.status !== 0 && result.status !== 1) return { patch: "", binary: false };
  const patch = result.stdout;
  return { patch, binary: /^Binary files .* differ$/m.test(patch) };
}

/**
 * Commit everything in the session's checkout.
 *
 * THE ONLY MUTATION IN THIS MODULE, and everything about it is chosen so that
 * pressing it by accident costs nothing you cannot get back.
 *
 * `add -A` RATHER THAN A STAGING UI. You did not write these changes — an agent
 * did — so "which hunks do I stage" is bookkeeping for authorship you do not
 * have. The question a reviewer actually has is "is this work good", and the
 * answer is a snapshot of all of it or none.
 *
 * NOTHING TO COMMIT IS NOT AN ERROR. A clean tree is the ordinary state after a
 * session that only read, and a red failure for it would teach the reader to
 * distrust the button.
 */
export function commitSessionWork(
  git: GitRunner,
  input: { cwd: string; message: string },
): { committed: boolean; commit?: GitCommitEntry; reason?: string } {
  const inside = git(input.cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.status !== 0 || inside.stdout.trim() !== "true") {
    return { committed: false, reason: "This session's workspace is not a git repository." };
  }
  const staged = git(input.cwd, ["add", "-A"]);
  if (staged.status !== 0) {
    return { committed: false, reason: staged.stderr.trim() || "git could not stage this session's changes." };
  }
  // Checked AFTER staging, because untracked files only become visible to
  // `diff --cached` once they are added.
  if (git(input.cwd, ["diff", "--cached", "--quiet"]).status === 0) {
    return { committed: false, reason: "Nothing to commit — this session's checkout matches its last commit." };
  }
  const committed = git(input.cwd, ["commit", "-m", input.message]);
  if (committed.status !== 0) {
    // A pre-commit hook that refuses is the common case here, and its own
    // output is the only useful thing to show — so it is passed through rather
    // than replaced with a generic failure.
    return { committed: false, reason: committed.stderr.trim() || committed.stdout.trim() || "git refused the commit." };
  }
  const entry = parseGitLog(git(input.cwd, ["log", "-1", `--format=${GIT_LOG_FORMAT}`]).stdout)[0];
  return { committed: true, ...(entry ? { commit: entry } : {}) };
}

/** The base-ref picker's menu can only be so long before it stops being a
 *  menu; newest-first means what falls off is what nobody was reaching for. */
const MAX_REFS = 200;

/**
 * Every branch a worktree could be cut from: local heads and remote-tracking
 * refs, newest commit first.
 *
 * ONE `for-each-ref`, NO NETWORK. Remote entries are whatever the last fetch
 * saw — the engine's git surface is read-only by construction and a listing
 * must never become the thing that talks to a server. `origin/HEAD` is a
 * pointer, not a branch, and is dropped.
 */
export function listGitRefs(git: GitRunner, projectRoot: string): GitRefEntry[] {
  /**
   * TWO CALLS, ONE PER NAMESPACE, so the kind is known by which call answered
   * — never guessed from the shape of the name, where a local branch called
   * `origin/anything` (legal, if perverse) would misfile. This listing rides
   * the composer foot's 15-second poll, so it must stay two subprocesses, not
   * one per ref.
   */
  const half = (namespace: string, kind: GitRefEntry["kind"]): GitRefEntry[] => {
    const listed = git(projectRoot, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)%09%(HEAD)", namespace]);
    if (listed.status !== 0) return [];
    const refs: GitRefEntry[] = [];
    for (const line of listed.stdout.split("\n")) {
      if (!line.trim()) continue;
      const [name = "", headMark = ""] = line.split("\t");
      if (!name || name.endsWith("/HEAD")) continue;
      refs.push({ name, kind, ...(headMark.trim() === "*" ? { head: true } : {}) });
      if (refs.length >= MAX_REFS) break;
    }
    return refs;
  };
  return [...half("refs/heads", "local"), ...half("refs/remotes", "remote")].slice(0, MAX_REFS);
}

/**
 * What a fresh worktree should be cut from when nobody says otherwise: the
 * remote's own default branch. `origin/HEAD` is the authoritative pointer, but
 * it only exists after a clone (or `remote set-head`) — a hand-added remote
 * never has one, so the common names are checked against the refs that
 * actually exist. Absent when there is no remote-tracking state at all, and
 * the caller's default falls back to the checkout's HEAD.
 */
export function defaultRemoteBase(git: GitRunner, projectRoot: string, refs: GitRefEntry[]): string | undefined {
  const pointed = git(projectRoot, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]);
  if (pointed.status === 0) {
    const name = pointed.stdout.trim().replace(/^refs\/remotes\//, "");
    // Trusted only if the branch it points at is still real — a stale pointer
    // to a deleted default would seed every worktree with a failing ref.
    if (name && refs.some((ref) => ref.kind === "remote" && ref.name === name)) return name;
  }
  for (const guess of ["origin/main", "origin/master"]) {
    if (refs.some((ref) => ref.kind === "remote" && ref.name === guess)) return guess;
  }
  return undefined;
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
  const refs = listGitRefs(git, projectRoot);
  const defaultBase = defaultRemoteBase(git, projectRoot, refs);

  return {
    repository: true,
    ...(branch ? { branch } : {}),
    dirtyFiles,
    ...(divergence ?? {}),
    worktrees: worktrees.status === 0 ? parseWorktreeList(worktrees.stdout, projectRoot) : [],
    refs,
    ...(defaultBase ? { defaultBase } : {}),
  };
}

/** Nonblocking read counterpart; uses the same parsers and fallback semantics above. */
export async function sessionDiffAsync(git: AsyncGitRunner, input: { cwd: string; baseRef?: string }): Promise<SessionDiff> {
  const { cwd, baseRef } = input;
  const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.status !== 0 || inside.stdout.trim() !== "true") {
    return { repository: false, workspacePath: cwd, files: [], commits: [], linesAdded: 0, linesRemoved: 0, truncated: false };
  }

  const head = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const raw = head.status === 0 ? head.stdout.trim() : "";
  const branch = raw && raw !== "HEAD" ? raw : undefined;


  const resolved = baseRef && (await git(cwd, ["rev-parse", "--verify", "--quiet", baseRef])).status === 0 ? baseRef : undefined;
  const against = resolved ?? "HEAD";

  const numstat = await git(cwd, ["diff", "-z", "--numstat", "--find-renames", against, "--"]);
  const nameStatus = await git(cwd, ["diff", "-z", "--name-status", "--find-renames", against, "--"]);
  const statuses = nameStatus.status === 0 ? parseNameStatus(nameStatus.stdout) : new Map<string, GitChangeStatus>();
  const tracked: GitFileChange[] = (numstat.status === 0 ? parseNumstat(numstat.stdout) : []).map((entry) => ({
    path: entry.path,
    status: statuses.get(entry.path) ?? "modified",
    ...(entry.renamedFrom ? { renamedFrom: entry.renamedFrom } : {}),
    ...(entry.added === undefined ? {} : { linesAdded: entry.added }),
    ...(entry.removed === undefined ? {} : { linesRemoved: entry.removed }),
    ...(entry.binary ? { binary: true } : {}),
  }));

  const status = await git(cwd, ["status", "--porcelain", "-z", "-uall"]);
  const untracked: GitFileChange[] = (status.status === 0 ? parseUntracked(status.stdout) : []).map((path) => ({
    path,
    status: "untracked" as const,
  }));

  const log = resolved ? (await git(cwd, ["log", `--format=${GIT_LOG_FORMAT}`, `${resolved}..HEAD`])) : undefined;
  const commits = log?.status === 0 ? parseGitLog(log.stdout) : [];

  const tracking = await git(cwd, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
  const divergence = tracking.status === 0 ? parseAheadBehind(tracking.stdout) : undefined;

  const all = [...tracked, ...untracked].sort((left, right) => left.path.localeCompare(right.path));
  return {
    repository: true,
    workspacePath: cwd,
    ...(branch ? { branch } : {}),
    ...(resolved ? { base: resolved } : {}),
    ...(divergence ?? {}),
    files: all.slice(0, MAX_REVIEW_FILES),
    commits,
    linesAdded: all.reduce((sum, file) => sum + (file.linesAdded ?? 0), 0),
    linesRemoved: all.reduce((sum, file) => sum + (file.linesRemoved ?? 0), 0),
    truncated: all.length > MAX_REVIEW_FILES,
  };
}

export async function sessionFilePatchAsync(
  git: AsyncGitRunner,
  input: { cwd: string; baseRef?: string; path: string; untracked?: boolean },
): Promise<{ patch: string; binary: boolean }> {
  const { cwd, baseRef, path: target } = input;
  const against = baseRef && (await git(cwd, ["rev-parse", "--verify", "--quiet", baseRef])).status === 0 ? baseRef : "HEAD";
  const result = input.untracked
    ? (await git(cwd, ["diff", "--no-index", "--unified=3", "--", "/dev/null", target]))
    : (await git(cwd, ["diff", "--unified=3", against, "--", target]));
  if (result.status !== 0 && result.status !== 1) return { patch: "", binary: false };
  const patch = result.stdout;
  return { patch, binary: /^Binary files .* differ$/m.test(patch) };
}

export async function listGitRefsAsync(git: AsyncGitRunner, projectRoot: string): Promise<GitRefEntry[]> {

  const half = async (namespace: string, kind: GitRefEntry["kind"]): Promise<GitRefEntry[]> => {
    const listed = await git(projectRoot, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)%09%(HEAD)", namespace]);
    if (listed.status !== 0) return [];
    const refs: GitRefEntry[] = [];
    for (const line of listed.stdout.split("\n")) {
      if (!line.trim()) continue;
      const [name = "", headMark = ""] = line.split("\t");
      if (!name || name.endsWith("/HEAD")) continue;
      refs.push({ name, kind, ...(headMark.trim() === "*" ? { head: true } : {}) });
      if (refs.length >= MAX_REFS) break;
    }
    return refs;
  };
  return [...await half("refs/heads", "local"), ...await half("refs/remotes", "remote")].slice(0, MAX_REFS);
}

export async function defaultRemoteBaseAsync(git: AsyncGitRunner, projectRoot: string, refs: GitRefEntry[]): Promise<string | undefined> {
  const pointed = await git(projectRoot, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]);
  if (pointed.status === 0) {
    const name = pointed.stdout.trim().replace(/^refs\/remotes\//, "");
    if (name && refs.some((ref) => ref.kind === "remote" && ref.name === name)) return name;
  }
  for (const guess of ["origin/main", "origin/master"]) {
    if (refs.some((ref) => ref.kind === "remote" && ref.name === guess)) return guess;
  }
  return undefined;
}

export async function gitOverviewAsync(git: AsyncGitRunner, projectRoot: string): Promise<GitOverview> {
  const inside = await git(projectRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.status !== 0 || inside.stdout.trim() !== "true") return EMPTY;
  const head = await git(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const raw = head.status === 0 ? head.stdout.trim() : "";
  const branch = raw && raw !== "HEAD" ? raw : undefined;

  const status = await git(projectRoot, ["status", "--porcelain"]);
  const dirtyFiles = status.status === 0 ? countDirty(status.stdout) : 0;
  const tracking = await git(projectRoot, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
  const divergence = tracking.status === 0 ? parseAheadBehind(tracking.stdout) : undefined;

  const worktrees = await git(projectRoot, ["worktree", "list", "--porcelain"]);
  const refs = await listGitRefsAsync(git, projectRoot);
  const defaultBase = await defaultRemoteBaseAsync(git, projectRoot, refs);

  return {
    repository: true,
    ...(branch ? { branch } : {}),
    dirtyFiles,
    ...(divergence ?? {}),
    worktrees: worktrees.status === 0 ? parseWorktreeList(worktrees.stdout, projectRoot) : [],
    refs,
    ...(defaultBase ? { defaultBase } : {}),
  };
}