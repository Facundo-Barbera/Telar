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
 * THERE ARE EXACTLY TWO MUTATIONS, `commitSessionWork` and `pushSessionBranch`,
 * and the first one's shape is the rule: a human pressed a button, it is
 * additive, and it is recoverable. `git commit` can be undone with a reset;
 * `git restore`, `git checkout <branch>` and a hunk-level index cannot, and a
 * panel that refreshes every fifteen seconds beside an agent that is still
 * writing is the worst possible place to offer them. The frozen cockpit offered
 * all three (see `apps/web_old/components/session/workspace-git-pane.tsx`): a
 * branch list whose rows ran `git checkout` in the tree an agent was working in,
 * with no confirmation. Their absence here is a decision, not a gap.
 *
 * ── `pushSessionBranch` IS THE DELIBERATE NETWORKED EXCEPTION — issue #670 ───
 *
 * Every other line in this module is local. `listGitRefs` says so outright —
 * "ONE `for-each-ref`, NO NETWORK … a listing must never become the thing that
 * talks to a server" — and that rule is NOT weakened by what follows: nothing
 * that runs on a timer, on a poll, or on a surface opening may reach the
 * network. A push runs when, and only when, a person presses a button that says
 * it will push.
 *
 * AND IT IS ONLY AMBIGUOUSLY RECOVERABLE, which is the honest weakening of the
 * rule above and is written here rather than assumed. A pushed branch can be
 * deleted; a branch that CI has already picked up, or that somebody has already
 * pulled, is not undone by deleting it. What keeps this inside the rule is the
 * other half — it is purely ADDITIVE. The argv is fixed at
 * `push --set-upstream origin <branch>` and is never composed from a caller:
 * there is no `--force`, no `--force-with-lease`, no `--delete` and no
 * `+`-prefixed refspec anywhere in this engine, and `scripts/source-invariants.mjs`
 * fails the build if one appears. A push that can only ever append commits to a
 * branch the session itself created is recoverable in the way that matters: it
 * cannot destroy anything that was already there.
 *
 * `--set-upstream` IS REQUIRED, NOT COSMETIC. `createSessionWorktreeAsync` cuts
 * a branch with `worktree add -b` and sets no tracking ref, so a bare `git push`
 * in a session's checkout fails on "no upstream branch" unless the machine
 * happens to have `push.autoSetupRemote` set.
 *
 * NO CREDENTIAL CROSSES THIS MODULE. `git` on this machine already has the
 * user's keychain helper, SSH agent or corporate helper, exactly as `gh` does —
 * see the header of ./github.ts, whose argument applies here word for word. The
 * one environment variable this module sets is `GIT_TERMINAL_PROMPT=0`, which
 * exists to REFUSE a credential prompt rather than to answer one.
 *
 * A PROJECT THAT IS NOT A REPOSITORY IS NOT AN ERROR. `envMode: "local"` exists
 * precisely so an unversioned directory can host sessions, so the overview
 * reports `repository: false` and stops. Throwing here would make the composer's
 * foot a failure state for a configuration the engine supports on purpose.
 */
import type {
  GitChangeStatus,
  GitCommitEntry,
  GitFileChange,
  GitFilePatch,
  GitPushRefusal,
  GitPushResult,
  ProjectAvailability,
  SessionDiff,
} from "@telar/engine-client";
import type { AsyncGitRunner, GitResult, GitRunner } from "./worktree.js";

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

/**
 * WHY A GIT READ IS NOT AN ANSWER — the distinction this module used to collapse.
 *
 * `timeout` is the case that earned this type. `defaultGitRunner` kills a child
 * at `DEFAULT_GIT_TIMEOUT_MS` and reports `GIT_TIMEOUT_STATUS`, so a stalled
 * subprocess arrives here as an ordinary non-zero exit — and every reader below
 * used to turn a non-zero exit into a FACT about the repository: no branches, a
 * clean tree, no worktrees. Those are confident wrong answers, and a person acts
 * on them. `files.ts` learnt this first (see `gitWorkspaceFilesAsync`); this is
 * the same lesson applied to the overview.
 *
 * `failed` is the rest — not a repository, an unreadable object store, a locked
 * index. Also not evidence of absence, but actionable differently: a retry is
 * the honest offer for a timeout and rarely the answer for the others.
 */
export type GitReadFailure = "timeout" | "failed";

/** `timedOut` first, because a killed child also carries a non-zero status. */
function failureOf(result: { status: number; timedOut?: true }): GitReadFailure | undefined {
  if (result.timedOut) return "timeout";
  return result.status === 0 ? undefined : "failed";
}

/** The worst of several failures, so an answer built from several reads reports
 *  the one a person can act on. A timeout outranks a plain failure: it is the
 *  case that says "ask again". */
function worseFailure(...failures: (GitReadFailure | undefined)[]): GitReadFailure | undefined {
  if (failures.includes("timeout")) return "timeout";
  return failures.find((failure) => failure !== undefined);
}

/**
 * A REF LISTING AND WHETHER IT IS THE WHOLE LISTING — issue #650.
 *
 * `refs` alone could not say that. The listing is two `for-each-ref` calls, one
 * per namespace, and when the local half timed out while the remote half
 * answered the result was a SHORTER LIST rather than an empty one — which is the
 * worse failure, because an empty picker looks broken and a short picker looks
 * complete. The person reads "that branch does not exist" and cuts their session
 * from a base they did not mean.
 *
 * SO THE PARTIAL LIST IS KEPT AND MARKED, rather than discarded. What git did
 * answer is still worth offering; what it must never do is pass for the whole
 * repository.
 */
export type GitRefListing = {
  /** What was listed. POSSIBLY PARTIAL — see `incomplete` before reading an
   *  absence here as "this repository has no such branch". */
  refs: GitRefEntry[];
  /** Set when at least one namespace did not answer. Absent is the ONLY state in
   *  which an empty `refs` means "this repository has no branches". */
  incomplete?: GitReadFailure;
};

export type GitOverview = {
  repository: boolean;
  branch?: string;
  /** Paths with staged, unstaged or untracked changes. ABSENT when git did not
   *  answer — never 0, which reads as a clean tree nobody looked at. */
  dirtyFiles?: number;
  /** Commits this branch has that its upstream does not, and vice versa.
   *  Both absent when there is no upstream — which is not the same as zero. */
  ahead?: number;
  behind?: number;
  /** Absent when `git worktree list` did not answer; `[]` only when there
   *  genuinely are none. */
  worktrees?: GitWorktreeEntry[];
  /** Cuttable bases, newest commit first, capped. Absent on a non-repository. */
  refs?: GitRefEntry[];
  /** Why `refs` is not the whole listing. Set means the picker must say so
   *  rather than draw a short list as if it were the repository. */
  refsIncomplete?: GitReadFailure;
  /** Whether the project's disk was there at all — stamped by the store, never
   *  by this module, which has no project to ask about. See `withAvailability`. */
  availability?: ProjectAvailability;
};

const EMPTY: GitOverview = { repository: false, dirtyFiles: 0, worktrees: [] };

/**
 * A TIMED-OUT PROBE IS NOT AN UNVERSIONED DIRECTORY — the same refusal
 * `files.ts:349` makes, at the top of every reader here.
 *
 * `rev-parse --is-inside-work-tree` is the gate: everything below reads its
 * answer as "this is/is not a repository". A killed child exits non-zero like a
 * plain `false` does, so without this the ONE state the engine supports on
 * purpose — an unversioned directory hosting `envMode: "local"` sessions — is
 * indistinguishable from a machine under load. The composer's foot drew the
 * second as the first: "Not a git repository", over a repository.
 *
 * THROWN RATHER THAN REPORTED because there is no smaller true answer to give:
 * every field below is a read of a repository we have not established exists.
 * The web's poll already has the channel for it — a rejected `projectGit` sets
 * `reachable: false` and the strip says the engine did not answer.
 */
function refuseTimedOutProbe(probe: { stderr: string; timedOut?: true }, what: string): void {
  if (probe.timedOut) throw new Error(probe.stderr || `${what} timed out`);
}

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
 *
 * AND EVERY SUB-READ BELOW CAN FAIL ON ITS OWN — issue #654. Each one used to
 * turn a non-zero exit into a fact about the session: no files, no commits, a
 * base that does not resolve. See `assembleDiff` for what says otherwise.
 */
export function sessionDiff(git: GitRunner, input: { cwd: string; baseRef?: string }): SessionDiff {
  const { cwd, baseRef } = input;
  const inside = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  refuseTimedOutProbe(inside, "Git review");
  if (inside.status !== 0 || inside.stdout.trim() !== "true") {
    return { repository: false, workspacePath: cwd, files: [], commits: [], linesAdded: 0, linesRemoved: 0, truncated: false };
  }

  const head = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const { base, baseUnverified } = resolveDiffBase(baseRef, baseRef ? git(cwd, ["rev-parse", "--verify", "--quiet", baseRef]) : undefined);
  const against = base ?? "HEAD";

  return assembleDiff(cwd, {
    head,
    ...(base ? { base } : {}),
    ...(baseUnverified ? { baseUnverified } : {}),
    numstat: git(cwd, ["diff", "-z", "--numstat", "--find-renames", against, "--"]),
    nameStatus: git(cwd, ["diff", "-z", "--name-status", "--find-renames", against, "--"]),
    // Untracked files are NOT in `git diff` at all, so a review built from the
    // diff alone would miss every file the agent created and never staged —
    // which for a scaffolding run is all of them.
    /**
     * `-uall` IS LOAD-BEARING. By default `git status` collapses a wholly
     * untracked directory into ONE entry with a trailing slash — `dist/` —
     * which is a row a reviewer cannot open, cannot count, and cannot judge.
     * Found by running this against a real repository: five new files under two
     * new directories arrived as two directory rows. Listing files individually
     * is what makes the review a review; the file cap and `truncated` handle
     * the pathological case of an unignored `node_modules`.
     */
    status: git(cwd, ["status", "--porcelain", "-z", "-uall"]),
    ...(base ? { log: git(cwd, ["log", `--format=${GIT_LOG_FORMAT}`, `${base}..HEAD`]) } : {}),
    tracking: git(cwd, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]),
  });
}

/**
 * WHETHER THE SESSION'S RECORDED BASE IS THE THING TO MEASURE FROM.
 *
 * A BASE THAT NO LONGER RESOLVES IS DROPPED, not reported. A worktree's base
 * commit can genuinely disappear — a rebase upstream, a `gc` after a branch was
 * deleted — and every read below would then fail with the same opaque "bad
 * revision". Falling back to HEAD gives a smaller true answer instead of an
 * error a reader cannot act on.
 *
 * A VERIFY THAT WAS KILLED IS NOT THAT — issue #654, and the quiet half of it.
 * The session RECORDED this ref when its worktree was cut, so `rev-parse
 * --verify` is CORROBORATION and not the source; the same relationship
 * `defaultRemoteBase` has with `symbolic-ref`, where #650 found that an
 * incomplete listing must not veto a pointer git answered on its own. Dropping
 * the base on a timeout silently reframes the whole review from `base…worktree`
 * to `HEAD…worktree` — which excludes every commit the session made, so a
 * session that COMMITTED all of its work reads as having done none of it, under
 * a sentence ("no starting commit was recorded") that is itself false.
 *
 * So the recorded base is kept and marked. If it really has gone, the reads
 * against it fail and report themselves through `filesIncomplete` and
 * `commitsIncomplete` — a marked failure, not a confident smaller answer.
 */
function resolveDiffBase(
  baseRef: string | undefined,
  verify: GitResult | undefined,
): { base?: string; baseUnverified?: GitReadFailure } {
  if (!baseRef || !verify) return {};
  if (verify.status === 0) return { base: baseRef };
  /**
   * ONLY A TIMEOUT KEEPS THE BASE. A plain non-zero from `--verify --quiet` IS
   * the answer "that ref does not resolve" — the pinned case above, and the one
   * the fallback to HEAD was written for. `failed` is therefore not produced
   * here today; the field carries the shared enum so the three incompleteness
   * channels read as one family and a distinguishable hard failure (a corrupt
   * object store, say) has somewhere to go later.
   */
  return verify.timedOut ? { base: baseRef, baseUnverified: "timeout" } : {};
}

/**
 * WHETHER AN ANCHORED COMMIT IS STILL THERE — issue #741.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * AN ANCHOR DEGRADES; IT MUST NOT LIE. A turn's `before`/`after` are shas the
 * engine observed while the turn ran, and history moves afterwards. Measured in
 * throwaway repositories: after `git commit --amend` the pre-amend sha is STILL
 * a readable object and `git diff <old> <new>` still works; after
 * `reflog expire --expire-unreachable=now --all && gc --prune=now` it is gone.
 *
 * `resolveDiffBase`'S LESSON RUNS THE OTHER WAY HERE, and that is the whole
 * reason this is a separate function rather than a second call to it. There, a
 * ref that does not resolve falls back to HEAD, because a *name* the user typed
 * being wrong is a user error with an obvious recovery. Here the sha was
 * recorded by the engine, and falling back to HEAD would answer a comparison
 * NOBODY ASKED FOR with real hunks, and look entirely plausible doing it.
 * A missing object means the anchor is gone, and the only honest answer is to
 * say so.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * `^{commit}` RATHER THAN A BARE SHA, so a sha that happens to name a blob or a
 * tree is refused rather than fed to `diff` as one side of a range.
 */
export function anchorArgs(sha: string): string[] {
  return ["cat-file", "-e", `${sha}^{commit}`];
}

/** What `cat-file -e` said about an anchor: present, gone, or unread. */
export function readAnchorProbe(result: GitResult): { present: boolean; incomplete?: GitReadFailure } {
  if (result.timedOut) return { present: false, incomplete: "timeout" };
  // Non-zero from `cat-file -e` is the answer "no such object", which is a FACT
  // about the repository rather than a failure of the read.
  return { present: result.status === 0 };
}

/**
 * THE REVIEW, ASSEMBLED FROM READS THAT EACH MAY HAVE FAILED — issue #654.
 *
 * SHARED BY BOTH RUNNERS so the synchronous and nonblocking reviews can never
 * drift in what they consider a change or in what they admit not knowing — the
 * same reason `parseRefLines` and `joinRefHalves` exist.
 *
 * WHY THREE CHANNELS RATHER THAN ONE `incomplete`. A single flag would be
 * smaller and it would be honest, but it would make a person distrust the wrong
 * half of the screen: these three are read by different eyes and cost different
 * things to be wrong about.
 *
 *   - `filesIncomplete` — the list is short or its letters are guesses, so the
 *     totals under-count. This is the one a reviewer must see BEFORE pressing
 *     commit.
 *   - `commitsIncomplete` — `git log` did not answer, so committed work may be
 *     missing from a review that claims to include it. Nothing in the file list
 *     is wrong.
 *   - `baseUnverified` — nothing has confirmed the frame of reference; see
 *     `resolveDiffBase`.
 *
 * And the empty case is the one that matters, because it is the claim a person
 * acts on: 0 files and 0 commits. Which flag is set is exactly what tells a
 * reader whether to distrust the file half, the commit half or neither — with
 * one flag, a `git log` that timed out would forbid the perfectly true sentence
 * "nothing in the working tree differs".
 *
 * THE PARTIAL ANSWER IS KEPT, per #650: `linesAdded` and `linesRemoved` stay
 * required and stay honest sums over the rows that DID arrive. They are not
 * made optional, because a review of an install with no tracked half is still
 * worth reading; `filesIncomplete` is the channel that says they are not the
 * whole change.
 */
function assembleDiff(
  cwd: string,
  reads: {
    head: GitResult;
    base?: string;
    baseUnverified?: GitReadFailure;
    numstat: GitResult;
    nameStatus: GitResult;
    status: GitResult;
    /** Absent when there is no base to log a range against — which is not a
     *  failure to log, and must not be marked as one. */
    log?: GitResult;
    tracking: GitResult;
  },
): SessionDiff {
  // `--abbrev-ref HEAD` gives "HEAD" on a detached checkout; that is a real
  // state and reporting it as a branch name would be a lie, so it is dropped.
  const raw = reads.head.status === 0 ? reads.head.stdout.trim() : "";
  const branch = raw && raw !== "HEAD" ? raw : undefined;

  const statuses = reads.nameStatus.status === 0 ? parseNameStatus(reads.nameStatus.stdout) : new Map<string, GitChangeStatus>();
  const tracked: GitFileChange[] = (reads.numstat.status === 0 ? parseNumstat(reads.numstat.stdout) : []).map((entry) => ({
    path: entry.path,
    status: statuses.get(entry.path) ?? "modified",
    ...(entry.renamedFrom ? { renamedFrom: entry.renamedFrom } : {}),
    ...(entry.added === undefined ? {} : { linesAdded: entry.added }),
    ...(entry.removed === undefined ? {} : { linesRemoved: entry.removed }),
    ...(entry.binary ? { binary: true } : {}),
  }));
  const untracked: GitFileChange[] = (reads.status.status === 0 ? parseUntracked(reads.status.stdout) : []).map((path) => ({
    path,
    status: "untracked" as const,
  }));

  /**
   * ALL THREE FILE READS FEED ONE FLAG, including the one that only decorates.
   *
   * `numstat` and `status` losing rows and `name-status` losing LETTERS are
   * different sizes of wrong, and separating them would be a fourth channel
   * whose only effect is a slightly narrower sentence. A row that says
   * "modified" about a file git deleted is a wrong claim about that file, so it
   * belongs on the same flag — which is why the surfaces say "not everything
   * git knows" rather than the more specific "files are missing".
   *
   * A PLAIN FAILURE COUNTS HERE, unlike `gitOverview`'s dirty count, which
   * keeps its pinned `0` on one. That decision was about a COUNT on the
   * composer's foot, where a locked index really is usually a clean tree. This
   * is the list somebody is about to commit, and "no files" is the claim #654
   * is about — there is no reading of a failed `git diff` under which an empty
   * review is the safer answer.
   */
  const filesIncomplete = worseFailure(failureOf(reads.numstat), failureOf(reads.nameStatus), failureOf(reads.status));
  const commits = reads.log?.status === 0 ? parseGitLog(reads.log.stdout) : [];
  const commitsIncomplete = reads.log ? failureOf(reads.log) : undefined;

  // No upstream is the common case for a fresh branch and is NOT an error — git
  // exits non-zero and both figures stay absent rather than becoming 0.
  const divergence = reads.tracking.status === 0 ? parseAheadBehind(reads.tracking.stdout) : undefined;

  const all = [...tracked, ...untracked].sort((left, right) => left.path.localeCompare(right.path));
  return {
    repository: true,
    workspacePath: cwd,
    ...(branch ? { branch } : {}),
    ...(reads.base ? { base: reads.base } : {}),
    ...(reads.baseUnverified ? { baseUnverified: reads.baseUnverified } : {}),
    ...(divergence ?? {}),
    files: all.slice(0, MAX_REVIEW_FILES),
    ...(filesIncomplete ? { filesIncomplete } : {}),
    commits,
    ...(commitsIncomplete ? { commitsIncomplete } : {}),
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
 *
 * IGNORING WHITESPACE IS GIT'S JOB, NOT THE VIEWER'S — issue #694.
 *
 * The toolbar's toggle could not be a render option: the renderer is handed a
 * patch that git has already decided the shape of, and a hunk that exists only
 * because a line was re-indented is a hunk before any of it reaches the client.
 * Hiding those rows in the browser would leave the file's OWN header counting
 * them, which is the kind of disagreement this surface exists to catch rather
 * than to produce. So the flag goes where the decision is made.
 */
export function sessionFilePatch(
  git: GitRunner,
  input: { cwd: string; baseRef?: string; path: string; untracked?: boolean; ignoreWhitespace?: boolean; renamedFrom?: string },
): GitFilePatch {
  const { cwd, baseRef, path: target } = input;
  // Same corroboration as the review's — see `resolveDiffBase`. A killed verify
  // must not quietly re-point this patch at HEAD, which would draw real hunks
  // against the wrong starting point and look entirely plausible doing it.
  const { base } = resolveDiffBase(baseRef, baseRef ? git(cwd, ["rev-parse", "--verify", "--quiet", baseRef]) : undefined);
  const against = base ?? "HEAD";
  const ignoring = patchWhitespaceArgs(input.ignoreWhitespace);
  return input.untracked
    ? assemblePatch(git(cwd, [...RAW_PATHS, "diff", "--no-index", "--unified=3", ...ignoring, "--", "/dev/null", target]), { noIndex: true })
    : assemblePatch(git(cwd, [...RAW_PATHS, "diff", "--unified=3", ...ignoring, ...renameArgs(input.renamedFrom), against, "--", ...paths(target, input.renamedFrom)]), {
        noIndex: false,
      });
}

/**
 * BOTH PATHS, OR THE RENAME CANNOT BE SEEN — issue #694, §2.2.
 *
 * `git diff HEAD -- <newpath>` excludes the OLD path from the pathspec, so
 * rename detection has nothing to pair the new one with and git answers
 * `new file mode 100644` with every line as an addition. The row above it
 * already said "Renamed from src.txt" with ±0, off the list's own
 * `--find-renames` read — so one row made two contradictory claims, and the
 * renderer read the patch's as `type="new"`.
 *
 * Pass both and git reports `similarity index 100% / rename from / rename to`,
 * which the renderer models first-class as `rename-pure` with `prevName` set.
 */
function paths(target: string, renamedFrom?: string): string[] {
  return renamedFrom && renamedFrom !== target ? [literal(renamedFrom), literal(target)] : [literal(target)];
}

/** `--find-renames` EXPLICITLY, though git has defaulted to it since 2.9: the
 *  pairing above is the whole point of the second path, and `diff.renames=false`
 *  in somebody's config would turn it back into two unrelated files. */
function renameArgs(renamedFrom?: string): string[] {
  return renamedFrom ? ["--find-renames"] : [];
}

/**
 * A PATH IS NOT A PATHSPEC — issue #694, §2.6.
 *
 * `git diff -- <path>` reads its operand as a PATTERN. A file called
 * `brack[1].ts` next to `brack1.ts` therefore matched both, git printed two
 * files, the renderer parsed two files, and the row for one of them drew the
 * other one's changes inside it. `*`, `?` and a leading `!` have the same
 * exposure, and a leading `:` is pathspec magic that errors outright.
 *
 * The row's LIST is unaffected — `-z --numstat` emits literal paths — so this
 * is a disagreement between a row's label and the hunks underneath it, which is
 * the hardest kind of wrong answer to notice.
 *
 * NOT APPLIED TO THE `--no-index` ARM, and that is measured rather than
 * assumed: `--no-index` takes two FILESYSTEM PATHS, reads them literally
 * already, and answers `:(literal)brack[1].ts` with `error: Could not access`.
 * The magic prefix would turn a working read into a failing one.
 */
function literal(target: string): string {
  return `:(literal)${target}`;
}

/**
 * `core.quotePath` DEFAULTS TO TRUE, so a patch for `café.ts` is headed
 * `diff --git "a/caf\303\251.ts" …` and the renderer reads the escapes as the
 * name — issue #694, §2.7. Harmless while the file header is hidden; mojibake
 * the moment anything draws it, and wrong grammar selection for any name whose
 * quoting reaches the extension.
 *
 * ON BOTH ARMS, because both print that header. The `-z` reads that build the
 * file LIST are already immune: `-z` NUL-terminates and never quotes.
 */
const RAW_PATHS = ["-c", "core.quotePath=false"] as const;

/**
 * `-w` AND `--ignore-blank-lines` TOGETHER, because either alone leaves the
 * toggle half-true. `-w` drops a hunk whose only change is indentation; a hunk
 * whose only change is a blank line inserted between two untouched statements
 * survives it, and that is the same kind of noise to the person who asked for
 * the noise to go away.
 *
 * NEVER `--ignore-all-space` ON ITS OWN FOR A WHOLE-FILE READ: git still emits
 * the file's `diff --git`/`index` header when every hunk is suppressed, and the
 * renderer is happy to show a file with no hunks. That reads as "nothing
 * differs here", which is exactly what the reader asked to be told.
 */
function patchWhitespaceArgs(ignoreWhitespace: boolean | undefined): string[] {
  return ignoreWhitespace ? ["-w", "--ignore-blank-lines"] : [];
}

/**
 * WHETHER WHAT CAME BACK IS A PATCH AT ALL — issue #654.
 *
 * `patch: ""` USED TO MEAN TWO THINGS, and the second rendered as a lie: a
 * `git diff` that exited past 1 returned the empty string, and every surface
 * reads an empty non-binary patch as "this file is binary, there is no textual
 * diff". A subprocess the engine killed at its bound therefore told the reader
 * something specific and wrong about the file's CONTENTS.
 *
 * Shared by both runners, for the reason `assembleDiff` is.
 *
 * ══ AND SINCE #694, `status === 1` IS NOT UNCONDITIONALLY SUCCESS ══
 *
 * It was, and that one line is where #654's defect came back through a
 * different door. `1` means "the two files differ" on the `--no-index` arm and
 * means GIT FAILED on the tracked one — and, on either, it is also what the
 * runner returns when it killed git for outrunning the output bound. So a
 * 3.26 MiB patch arrived here as 1,048,576 characters ending mid-line, with
 * `incomplete` absent, and rendered as the complete change.
 *
 * `#654 FIXED "AN UNREAD PATCH ARRIVES AS THE EMPTY STRING"; this is an unread
 * patch arriving as a megabyte of real hunks, which no reader can tell from a
 * whole one. WHICH ARM RAN IS PASSED IN rather than inferred from the status,
 * because inferring it is the mistake.
 */
function assemblePatch(result: GitResult, arm: { noIndex: boolean }): GitFilePatch {
  // BEFORE THE STATUS, because the bound is a fact about the read whichever arm
  // produced it — and on `--no-index` the overflow's `1` is indistinguishable
  // from that command's success. What did arrive is KEPT and marked, per #650:
  // a megabyte of real hunks is worth reading, and must never pass for all of
  // them.
  if (result.overflowed) return { patch: result.stdout, binary: false, incomplete: "truncated" };
  // 1 is `--no-index` reporting that the two files differ, which is that
  // command's success and nothing else's.
  if (result.status !== 0 && !(arm.noIndex && result.status === 1)) {
    return { patch: "", binary: false, incomplete: result.timedOut ? "timeout" : "failed" };
  }
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
  // NOT "not a git repository" — a killed probe is a machine under load, and
  // telling someone their checkout is unversioned sends them looking for a
  // problem that is not there rather than pressing the button again.
  if (inside.timedOut) return { committed: false, reason: "git did not answer in time — try again." };
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

// ── publishing a session's branch ───────────────────────────────────────────

/**
 * How long a push may take before it is killed.
 *
 * LONGER THAN `DEFAULT_GIT_TIMEOUT_MS`, because this is the only git child in
 * the engine whose wall clock is somebody's upload: a first push of a branch
 * carrying a few hundred objects over a domestic connection is comfortably past
 * thirty seconds, and killing it would leave a half-finished push and a person
 * told "git did not answer" about a command that was working.
 *
 * AND STILL BOUNDED, because it holds a slot in the worktree runner's two-slot
 * pool while it runs — see `defaultWorktreeGitRunner`. A minute of one slot is a
 * session creation queued behind it for a minute; an unbounded push would be
 * that slot gone for good.
 */
export const PUSH_TIMEOUT_MS = 60_000;

/**
 * THE ARGV, AS A CONSTANT, so there is exactly one push in this engine and its
 * shape is readable in one line.
 *
 * NOTHING HERE COMES FROM A CALLER EXCEPT THE BRANCH NAME, and the branch name
 * is the session's own — read off the session record by the store, never off a
 * request body. See the module header for why there is no force, no delete and
 * no caller-supplied refspec, and `scripts/source-invariants.mjs` for the check
 * that keeps a second one from appearing.
 */
export function pushArgv(branch: string): string[] {
  return ["push", "--set-upstream", "origin", branch];
}

/**
 * The environment one push runs with.
 *
 * `GIT_TERMINAL_PROMPT=0` AND NOTHING ELSE. A push against an HTTPS remote with
 * no usable credential helper otherwise blocks on "Username for
 * 'https://github.com':" — a prompt nobody can answer, which burns the whole
 * timeout and reports a killed child rather than the credential problem it
 * actually is. Refused, it exits immediately with words `classifyPushFailure`
 * can name. See `GitRunOptions.env`: this is a channel for refusing a question,
 * never for answering one.
 */
export const PUSH_ENV: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };

/**
 * What the engine can see about a session's branch WITHOUT touching the network.
 *
 * FIVE LOCAL READS, AND EVERY REFUSAL EITHER ARM MAKES BEFORE IT ACTS IS
 * DECIDED FROM THEM. That is the same trade `mergePull` makes — four of its
 * seven answers are facts rather than phrase matches — and it buys the same two
 * things: a refusal that is certain rather than guessed, and a refusal that
 * costs nothing on the far side.
 *
 * FACTS, NOT A VERDICT. Push and pull-request creation refuse on overlapping but
 * different grounds, and a shared function that returned "ok" or "no" would have
 * to speak both their vocabularies. This answers what is true; each arm decides
 * what that means for it.
 */
export type SessionBranchFacts = {
  repository: boolean;
  /** A probe was killed rather than answering. Nothing below it is known. */
  timedOut?: true;
  /** HEAD's branch. ABSENT on a detached HEAD, which is a real state and not a
   *  branch called "HEAD". */
  branch?: string;
  /** `origin`'s URL, verbatim. Absent when the checkout has no origin. */
  origin?: string;
  /** `refs/remotes/origin/<branch>` exists — this branch has been pushed at
   *  least once, as far as this checkout knows. */
  upstream?: boolean;
  /** Commits HEAD has that `origin/<branch>` does not. Absent when there is no
   *  remote-tracking ref to count against, which is NOT the same as zero. */
  ahead?: number;
};

export async function sessionBranchFacts(git: AsyncGitRunner, cwd: string): Promise<SessionBranchFacts> {
  const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.timedOut) return { repository: false, timedOut: true };
  if (inside.status !== 0 || inside.stdout.trim() !== "true") return { repository: false };

  const head = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (head.timedOut) return { repository: true, timedOut: true };
  const raw = head.status === 0 ? head.stdout.trim() : "";
  // `--abbrev-ref HEAD` answers the literal string "HEAD" on a detached
  // checkout. Reporting that as a branch name would have this engine push a ref
  // called HEAD; see `gitOverview`, which drops it for the same reason.
  const branch = raw && raw !== "HEAD" ? raw : undefined;

  const remote = await git(cwd, ["config", "--get", "remote.origin.url"]);
  if (remote.timedOut) return { repository: true, timedOut: true, ...(branch ? { branch } : {}) };
  const origin = remote.status === 0 ? remote.stdout.trim() : "";

  if (!branch || !origin) {
    return { repository: true, ...(branch ? { branch } : {}), ...(origin ? { origin } : {}) };
  }

  /**
   * THE REMOTE-TRACKING REF, NOT A FETCH. This is what the checkout last saw,
   * which may be older than the remote — and reading it is the difference
   * between a listing that talks to a server and one that does not. A stale
   * "nothing to push" is caught anyway: git answers `Everything up-to-date` and
   * `classifyPushOutcome` reports the same refusal from the push itself.
   */
  const tracking = `refs/remotes/origin/${branch}`;
  const exists = await git(cwd, ["rev-parse", "--verify", "--quiet", tracking]);
  if (exists.timedOut) return { repository: true, branch, origin, timedOut: true };
  if (exists.status !== 0) return { repository: true, branch, origin, upstream: false };

  const counted = await git(cwd, ["rev-list", "--count", `${tracking}..HEAD`]);
  if (counted.timedOut) return { repository: true, branch, origin, upstream: true, timedOut: true };
  const ahead = counted.status === 0 ? Number.parseInt(counted.stdout.trim(), 10) : Number.NaN;
  return { repository: true, branch, origin, upstream: true, ...(Number.isFinite(ahead) ? { ahead } : {}) };
}

/**
 * Why `git push` refused, when the engine could not already tell.
 *
 * MATCHED ON GIT'S OWN WORDS, like `classifyGhFailure` and `classifyMergeFailure`
 * and for the same reason: git exits 1 for almost all of these, so the status
 * cannot tell them apart. The fallback is `failed` with the message passed
 * through, so a phrasing change degrades to "here is what git said" rather than
 * to a wrong diagnosis.
 *
 * ── WHAT SEPARATES THE THREE REFUSALS THAT COULD BE CONFUSED ────────────────
 *
 * EVERY ONE OF THEM IS SEPARATED BY TOKENS, NOT BY ORDER — and that is worth
 * writing down precisely, because the instinct is to reach for order and
 * because an earlier draft of this comment claimed the opposite. Measured, by
 * reverting each block in turn:
 *
 * `auth` VERSUS `not_permitted`. SSH spells a missing key as "Permission denied
 * (publickey)" and GitHub spells a 403 as "Permission to owner/repo.git denied
 * to someone". Both contain the word "permission", which is exactly why neither
 * block tests for that word alone: `auth` matches `permission denied
 * (publickey)` and `not_permitted` matches `permission to` / `denied to`, and
 * no real fixture for either matches the other's set. Drop the publickey token
 * from `auth` and the missing-key fixture does NOT fall through to
 * `not_permitted` — it lands on `failed`, which is the honest degradation this
 * function is built for, and is what the test asserts.
 *
 * `not_permitted` VERSUS `rejected`. Measured, a real `pre-receive` decline:
 *
 *     ! [remote rejected] main -> main (pre-receive hook declined)
 *
 * and a real non-fast-forward:
 *
 *     ! [rejected]        main -> main (fetch first)
 *
 * `[remote rejected]` does not contain `[rejected]`, so the two token sets are
 * disjoint and swapping the blocks changes nothing — measured, not assumed.
 * What the SEPARATION buys is the thing that matters: the first needs a
 * different branch or a different account, the second needs a pull, and telling
 * somebody to rebase a branch a hook declined wastes their afternoon. The test
 * for it asserts the two fixtures land differently, which is the claim; it does
 * not assert an order that is not doing any work.
 */
export function classifyPushFailure(result: Pick<GitResult, "stdout" | "stderr">): { refusal: GitPushRefusal; message?: string } {
  const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
  const message = result.stderr.trim() || result.stdout.trim();
  const carry = message ? { message } : {};
  if (
    text.includes("terminal prompts disabled") ||
    text.includes("could not read username") ||
    text.includes("could not read password") ||
    text.includes("authentication failed") ||
    text.includes("permission denied (publickey)") ||
    text.includes("invalid username or password") ||
    text.includes("no supported authentication")
  ) {
    return { refusal: "auth", ...carry };
  }
  if (
    text.includes("[remote rejected]") ||
    text.includes("hook declined") ||
    text.includes("protected branch") ||
    text.includes("denied to") ||
    text.includes("http 403") ||
    text.includes("error: 403") ||
    text.includes("write access") ||
    text.includes("permission to")
  ) {
    return { refusal: "not_permitted", ...carry };
  }
  if (
    text.includes("[rejected]") ||
    text.includes("non-fast-forward") ||
    text.includes("fetch first") ||
    text.includes("updates were rejected")
  ) {
    return { refusal: "rejected", ...carry };
  }
  if (text.includes("does not appear to be a git repository") || text.includes("no such remote") || text.includes("does not exist")) {
    return { refusal: "no_remote", ...carry };
  }
  return { refusal: "failed", ...carry };
}

/**
 * GIT EXITED 0 AND STILL MOVED NOTHING, which is a sentence and not a failure.
 *
 * The check before the push reads the remote-tracking ref, which is what this
 * checkout LAST SAW — so a branch somebody else already pushed for us looks
 * behind when it is level. Git's own answer to that is `Everything up-to-date`
 * on a successful exit, and reporting "pushed" over it would be this surface
 * claiming a thing it did not do.
 *
 * BOTH STREAMS ARE READ, because which one carries it is a git version detail:
 * measured on 2.x the phrase arrives on stderr while `--set-upstream`'s own
 * "branch 'x' set up to track 'origin/x'" arrives on stdout.
 */
export function pushMovedNothing(result: Pick<GitResult, "stdout" | "stderr">): boolean {
  return `${result.stderr}\n${result.stdout}`.toLowerCase().includes("everything up-to-date");
}

/**
 * Publish the session's own branch.
 *
 * THE SECOND MUTATION IN THIS MODULE AND THE ONLY ONE THAT LEAVES THE MACHINE —
 * see the module header for the whole argument, including why a push is inside
 * the "additive and recoverable" rule that governs `commitSessionWork`.
 *
 * FIVE REFUSALS ARE DECIDED BEFORE GIT IS ASKED TO PUSH ANYTHING, and the point
 * is that each one is a fact rather than a phrase match. `local_checkout` costs
 * no subprocess at all: a `local` session shares the project's checkout with the
 * user's editor and with every other local session on it, so there is no
 * session-owned branch here to publish and nothing to look at to find that out.
 *
 * `not_session_branch` IS THE GUARD THE ISSUE ASKED FOR, ARRIVING BY ITS HONEST
 * ROUTE. #670's investigation asked to refuse when "the session's branch is its
 * base ref". A worktree session's recorded `baseRef` is a COMMIT SHA — see
 * `SessionWorkspace` — so there is no branch name to compare it against, and a
 * check written that way would never fire. What the guard was FOR is real: this
 * button must not push whatever happens to be checked out, because the way that
 * goes wrong is an agent having run `git checkout main` in the worktree and the
 * cockpit publishing the base branch. So the comparison is against the branch
 * the session was cut for, which is recorded, which catches that case and a
 * detached HEAD with it.
 */
export async function pushSessionBranch(
  git: AsyncGitRunner,
  input: {
    cwd: string;
    /** The session's workspace mode. `local` refuses before anything runs. */
    mode: "local" | "worktree";
    /** The branch this session was cut for. A `worktree` session always has
     *  one; it is read off the session record, never off a request. */
    branch?: string;
  },
): Promise<GitPushResult> {
  if (input.mode === "local") {
    return {
      pushed: false,
      refusal: "local_checkout",
      message: "This session works in the project's own checkout, which it shares with your editor. There is no session branch to publish.",
    };
  }
  const branch = input.branch?.trim();
  if (!branch) {
    return { pushed: false, refusal: "not_session_branch", message: "This session has no branch of its own recorded." };
  }

  const facts = await sessionBranchFacts(git, input.cwd);
  const refusal = refuseFromFacts(facts, branch);
  if (refusal) return refusal;

  const push = await git(input.cwd, pushArgv(branch), { timeoutMs: PUSH_TIMEOUT_MS, env: PUSH_ENV });
  // `timedOut` first, because a killed child also carries a non-zero status —
  // the same ordering `failureOf` states for the reads above.
  if (push.timedOut) {
    return { pushed: false, refusal: "timeout", message: `The push did not finish within ${PUSH_TIMEOUT_MS / 1_000}s and was stopped.` };
  }
  if (push.status !== 0) return { pushed: false, ...classifyPushFailure(push) };
  if (pushMovedNothing(push)) {
    return { pushed: false, refusal: "nothing_to_push", message: `origin already has every commit on ${branch}.` };
  }
  return {
    pushed: true,
    branch,
    ...(facts.ahead === undefined ? {} : { commits: facts.ahead }),
    ...(facts.upstream === false ? { created: true } : {}),
  };
}

/**
 * The refusals both arms share, decided from facts alone.
 *
 * SHARED SO THE TWO ARMS CANNOT DISAGREE about whether this checkout is in a
 * state worth acting on — which is the failure a second hand-written copy of
 * these four `if`s would produce on the first one somebody edits.
 */
function refuseFromFacts(facts: SessionBranchFacts, branch: string): { pushed: false; refusal: GitPushRefusal; message: string } | undefined {
  // NOT "not a git repository" — a killed probe is a machine under load, and
  // telling somebody their checkout is unversioned sends them looking for a
  // problem that is not there. Same judgement as `commitSessionWork`'s.
  if (facts.timedOut) return { pushed: false, refusal: "timeout", message: "git did not answer in time — try again." };
  if (!facts.repository) return { pushed: false, refusal: "not_repository", message: "This session's workspace is not a git repository." };
  if (!facts.origin) {
    return { pushed: false, refusal: "no_remote", message: "This checkout has no origin, so there is nowhere to push it." };
  }
  if (facts.branch !== branch) {
    return {
      pushed: false,
      refusal: "not_session_branch",
      message: facts.branch
        ? `This checkout is on ${facts.branch}, not on this session's branch ${branch}.`
        : `This checkout is not on a branch, so ${branch} is not what would be pushed.`,
    };
  }
  if (facts.upstream === true && facts.ahead === 0) {
    return { pushed: false, refusal: "nothing_to_push", message: `origin already has every commit on ${branch}.` };
  }
  return undefined;
}

/**
 * Whether the pull-request arm may act, from the same facts.
 *
 * SEPARATE FROM THE PUSH'S because the two arms genuinely disagree about one
 * thing: a branch with no upstream is exactly what the push arm exists for and
 * is the one state a pull request cannot be opened on. #670's investigation is
 * explicit that these must not be one button, and this is where that stops being
 * a UI opinion and becomes a rule.
 */
export function pullRequestBlockedBy(facts: SessionBranchFacts, branch: string): { refusal: GitPushRefusal; message: string } | undefined {
  const shared = refuseFromFacts(facts, branch);
  if (shared) {
    // `nothing_to_push` does not block a pull request — a branch level with its
    // upstream is a branch that is fully published, which is the readiest a
    // pull request can be.
    if (shared.refusal === "nothing_to_push") return undefined;
    return { refusal: shared.refusal, message: shared.message };
  }
  return undefined;
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
export function listGitRefs(git: GitRunner, projectRoot: string): GitRefListing {
  /**
   * TWO CALLS, ONE PER NAMESPACE, so the kind is known by which call answered
   * — never guessed from the shape of the name, where a local branch called
   * `origin/anything` (legal, if perverse) would misfile. This listing rides
   * the composer foot's 15-second poll, so it must stay two subprocesses, not
   * one per ref.
   *
   * EACH HALF REPORTS ITS OWN FAILURE, which is the whole point: the observed
   * defect was one half timing out under load while the other answered, and the
   * caller could not tell the short list from a short repository.
   */
  const half = (namespace: string, kind: GitRefEntry["kind"]): GitRefListing => {
    const listed = git(projectRoot, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)%09%(HEAD)", namespace]);
    const failure = failureOf(listed);
    return { refs: failure ? [] : parseRefLines(listed.stdout, kind), ...(failure ? { incomplete: failure } : {}) };
  };
  return joinRefHalves(half("refs/heads", "local"), half("refs/remotes", "remote"));
}

/** One namespace's `for-each-ref` output. Shared by both runners so the sync and
 *  async listings can never drift in what they consider a ref. */
function parseRefLines(stdout: string, kind: GitRefEntry["kind"]): GitRefEntry[] {
  const refs: GitRefEntry[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [name = "", headMark = ""] = line.split("\t");
    if (!name || name.endsWith("/HEAD")) continue;
    refs.push({ name, kind, ...(headMark.trim() === "*" ? { head: true } : {}) });
    if (refs.length >= MAX_REFS) break;
  }
  return refs;
}

/** Locals then remotes, capped — and INCOMPLETE IF EITHER HALF WAS, because a
 *  listing missing one namespace is not a listing of the repository. */
function joinRefHalves(local: GitRefListing, remote: GitRefListing): GitRefListing {
  const incomplete = worseFailure(local.incomplete, remote.incomplete);
  return {
    refs: [...local.refs, ...remote.refs].slice(0, MAX_REFS),
    ...(incomplete ? { incomplete } : {}),
  };
}

/**
 * What a fresh worktree should be cut from when nobody says otherwise: the
 * remote's own default branch. `origin/HEAD` is the authoritative pointer, but
 * it only exists after a clone (or `remote set-head`) — a hand-added remote
 * never has one, so the common names are checked against the refs that
 * actually exist. Absent when there is no remote-tracking state at all, and
 * the caller's default falls back to the checkout's HEAD.
 *
 * TAKES THE LISTING, NOT THE REFS, because the corroboration below is only sound
 * against a listing that is whole — see the pointer note.
 */
export function defaultRemoteBase(git: GitRunner, projectRoot: string, listing: GitRefListing): string | undefined {
  const pointed = git(projectRoot, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]);
  if (pointed.status === 0) {
    const name = pointed.stdout.trim().replace(/^refs\/remotes\//, "");
    /**
     * Trusted only if the branch it points at is still real — a stale pointer to
     * a deleted default would seed every worktree with a failing ref.
     *
     * UNLESS THE LISTING IS INCOMPLETE, where absence from it is evidence of
     * nothing. `symbolic-ref` answered this question on its own; letting a
     * `for-each-ref` that was killed mid-flight veto it is how a timeout
     * silently changed which branch a fresh session was cut from — the default
     * quietly vanishing and the composer falling back to HEAD with nobody told.
     */
    if (name && (listing.incomplete !== undefined || listing.refs.some((ref) => ref.kind === "remote" && ref.name === name))) return name;
  }
  for (const guess of ["origin/main", "origin/master"]) {
    if (listing.refs.some((ref) => ref.kind === "remote" && ref.name === guess)) return guess;
  }
  return undefined;
}

/**
 * WHICH REPOSITORY A CHECKOUT IS A CHECKOUT OF — one string, comparable across
 * Macs.
 *
 * `origin` names the same repository in half a dozen spellings: an SSH scp-like
 * address, an HTTPS URL, `ssh://` with a port, with or without `.git`, with or
 * without a trailing slash, and (on a machine that pastes tokens into remotes)
 * with credentials in the authority. A person looking at two Macs would call
 * all of them "the same repo"; a string comparison would not. So this reduces
 * every spelling to `host/owner/repo` and that reduction — not the URL — is
 * what two projects are merged on.
 *
 * LOWERCASED, because the question being asked is "is this the same
 * repository", and the hosts people actually use (GitHub, GitLab, Bitbucket)
 * answer that case-insensitively. A `Owner/Repo` clone on one Mac and an
 * `owner/repo` clone on another are one repository, and telling the reader they
 * are two would be the more common error by far.
 *
 * CREDENTIALS ARE DROPPED, always. A remote can carry a PAT in its authority,
 * and this value travels to another Mac's cockpit as part of the project
 * record: a token in a rail group key would be a token on the wire and in
 * `localStorage`.
 *
 * A REMOTE WITH NO HOST IS NO ANSWER — `/srv/git/thing.git`, `file://…`, a
 * relative path. Two Macs both cloning from `/Users/me/repos/thing.git` mean
 * two different disks and almost certainly two different repositories, and
 * merging them in the rail on a matching path would be the one mistake this
 * whole comparison must not make. Absent, therefore, rather than guessed.
 */
export function normalizeRemote(remote: string | undefined): string | undefined {
  const raw = (remote ?? "").trim();
  if (!raw) return undefined;
  // scp-like (`git@host:owner/repo`) is not a URL and has no scheme; everything
  // else does, so the authority is whatever sits between it and the first path
  // segment. Both are reduced to "authority" + "path" before anything else.
  const scpLike = /^([^/@]+@)?([^/:]+):(?!\/)(.+)$/.exec(raw);
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\/(.*)$/i.exec(raw);
  let authority: string;
  let path: string;
  if (withScheme) {
    const rest = withScheme[1] ?? "";
    const cut = rest.indexOf("/");
    authority = cut < 0 ? rest : rest.slice(0, cut);
    path = cut < 0 ? "" : rest.slice(cut + 1);
  } else if (scpLike) {
    authority = scpLike[2] ?? "";
    path = scpLike[3] ?? "";
  } else {
    return undefined; // A bare path names a disk, not a repository. See above.
  }
  // `user:token@host:22` → `host`. The port goes with the credentials: it is a
  // property of how this Mac reaches the host, not of which host it is.
  const host = (authority.split("@").pop() ?? "").replace(/:\d+$/, "");
  const segments = path
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "");
  if (!host || segments.length === 0) return undefined;
  const last = segments.length - 1;
  segments[last] = (segments[last] ?? "").replace(/\.git$/i, "");
  if (!segments[last]) return undefined;
  return [host, ...segments].join("/").toLowerCase();
}

/** `origin`'s address, reduced by `normalizeRemote`. Absent on a checkout with
 *  no origin, on a directory that is not a repository, and on a remote this
 *  cannot reduce — all three of which are ordinary. */
export async function projectRemoteAsync(git: AsyncGitRunner, projectRoot: string): Promise<string | undefined> {
  const found = await git(projectRoot, ["config", "--get", "remote.origin.url"], { timeoutMs: 5_000 });
  return found.status === 0 ? normalizeRemote(found.stdout) : undefined;
}

export function gitOverview(git: GitRunner, projectRoot: string): GitOverview {
  const inside = git(projectRoot, ["rev-parse", "--is-inside-work-tree"]);
  refuseTimedOutProbe(inside, "Git overview");
  if (inside.status !== 0 || inside.stdout.trim() !== "true") return EMPTY;

  // `--abbrev-ref HEAD` gives "HEAD" on a detached checkout; that is a real
  // state and reporting it as a branch name would be a lie, so it is dropped.
  const head = git(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const raw = head.status === 0 ? head.stdout.trim() : "";
  const branch = raw && raw !== "HEAD" ? raw : undefined;

  /**
   * A COUNT NOBODY TOOK IS NO COUNT. A plain failure still reports 0 — a locked
   * index is the pinned case, and the tree behind it is usually clean — but a
   * KILLED `git status` is a measurement that never happened, and drawing it as
   * "0 changed" is the reassuring picture of an unexamined working tree that the
   * foot's own comment forbids.
   */
  const status = git(projectRoot, ["status", "--porcelain"]);
  const dirtyFiles = status.timedOut ? undefined : status.status === 0 ? countDirty(status.stdout) : 0;

  // No upstream is the common case for a fresh branch and is NOT an error —
  // git exits non-zero and both figures stay absent rather than becoming 0.
  const tracking = git(projectRoot, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
  const divergence = tracking.status === 0 ? parseAheadBehind(tracking.stdout) : undefined;

  const worktrees = git(projectRoot, ["worktree", "list", "--porcelain"]);
  const listing = listGitRefs(git, projectRoot);
  const defaultBase = defaultRemoteBase(git, projectRoot, listing);

  return {
    repository: true,
    ...(branch ? { branch } : {}),
    ...(dirtyFiles === undefined ? {} : { dirtyFiles }),
    ...(divergence ?? {}),
    // Same distinction as the count above: a killed `worktree list` is absent,
    // never the "0 worktrees" a reader would take for a fact.
    ...(worktrees.timedOut ? {} : { worktrees: worktrees.status === 0 ? parseWorktreeList(worktrees.stdout, projectRoot) : [] }),
    refs: listing.refs,
    ...(listing.incomplete ? { refsIncomplete: listing.incomplete } : {}),
    ...(defaultBase ? { defaultBase } : {}),
  };
}

/** Nonblocking read counterpart; uses the same parsers and fallback semantics above. */
export async function sessionDiffAsync(git: AsyncGitRunner, input: { cwd: string; baseRef?: string; to?: string }): Promise<SessionDiff> {
  const { cwd, baseRef, to } = input;
  const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  refuseTimedOutProbe(inside, "Git review");
  if (inside.status !== 0 || inside.stdout.trim() !== "true") {
    return { repository: false, workspacePath: cwd, files: [], commits: [], linesAdded: 0, linesRemoved: 0, truncated: false };
  }

  const head = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const { base, baseUnverified } = resolveDiffBase(baseRef, baseRef ? await git(cwd, ["rev-parse", "--verify", "--quiet", baseRef]) : undefined);
  const against = base ?? "HEAD";
  /**
   * A RANGE, OR A REF AGAINST THE WORKING TREE — issue #741.
   *
   * `[against]` is `git diff <base> --`: one ref against whatever is on the
   * disk right now. `[against, to]` is `git diff <base> <to>`: two commits,
   * an answer nothing on the disk can change. The turn scope needs the second
   * and there was no way to ask for it.
   */
  const range = to ? [against, to] : [against];

  return assembleDiff(cwd, {
    head,
    ...(base ? { base } : {}),
    ...(baseUnverified ? { baseUnverified } : {}),
    numstat: await git(cwd, ["diff", "-z", "--numstat", "--find-renames", ...range, "--"]),
    nameStatus: await git(cwd, ["diff", "-z", "--name-status", "--find-renames", ...range, "--"]),
    /**
     * THE UNTRACKED READ IS DROPPED OVER A RANGE, and this is the line that
     * matters. An untracked file is in no commit, so it is in no
     * commit-to-commit comparison — carrying `status -uall` into one would put
     * working-tree rows, possibly written long after the range ended, under a
     * heading that says what a turn did. That is #690's defect by a third
     * door, and it is refused HERE rather than left to each caller.
     *
     * `ok("")` rather than skipping the field: `assembleDiff` reads a failed
     * status as a reason to mark the list incomplete, and "there are no
     * untracked files in a range" is an answer, not a read that went wrong.
     */
    status: to ? { status: 0, stdout: "", stderr: "" } : await git(cwd, ["status", "--porcelain", "-z", "-uall"]),
    ...(base ? { log: await git(cwd, ["log", `--format=${GIT_LOG_FORMAT}`, `${base}..${to ?? "HEAD"}`]) } : {}),
    tracking: await git(cwd, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]),
  });
}

export async function sessionFilePatchAsync(
  git: AsyncGitRunner,
  input: { cwd: string; baseRef?: string; to?: string; path: string; untracked?: boolean; ignoreWhitespace?: boolean; renamedFrom?: string },
): Promise<GitFilePatch> {
  const { cwd, baseRef, path: target } = input;
  const { base } = resolveDiffBase(baseRef, baseRef ? await git(cwd, ["rev-parse", "--verify", "--quiet", baseRef]) : undefined);
  const against = base ?? "HEAD";
  const ignoring = patchWhitespaceArgs(input.ignoreWhitespace);
  /**
   * OVER A RANGE THERE IS NO UNTRACKED ARM AT ALL — issue #741. `--no-index`
   * compares a working file against `/dev/null`, which is a statement about the
   * disk; asking it inside a commit-to-commit comparison would answer a
   * different question from the list the row sits in. The range wins, and a row
   * that reached here marked untracked over one is a row the list should not
   * have produced.
   */
  const range = input.to ? [against, input.to] : [against];
  return input.untracked && !input.to
    ? assemblePatch(await git(cwd, [...RAW_PATHS, "diff", "--no-index", "--unified=3", ...ignoring, "--", "/dev/null", target]), { noIndex: true })
    : assemblePatch(
        await git(cwd, [
          ...RAW_PATHS,
          "diff",
          "--unified=3",
          ...ignoring,
          ...renameArgs(input.renamedFrom),
          ...range,
          "--",
          ...paths(target, input.renamedFrom),
        ]),
        { noIndex: false },
      );
}

export async function listGitRefsAsync(git: AsyncGitRunner, projectRoot: string): Promise<GitRefListing> {
  const half = async (namespace: string, kind: GitRefEntry["kind"]): Promise<GitRefListing> => {
    const listed = await git(projectRoot, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)%09%(HEAD)", namespace]);
    const failure = failureOf(listed);
    return { refs: failure ? [] : parseRefLines(listed.stdout, kind), ...(failure ? { incomplete: failure } : {}) };
  };
  return joinRefHalves(await half("refs/heads", "local"), await half("refs/remotes", "remote"));
}

export async function defaultRemoteBaseAsync(git: AsyncGitRunner, projectRoot: string, listing: GitRefListing): Promise<string | undefined> {
  const pointed = await git(projectRoot, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]);
  if (pointed.status === 0) {
    const name = pointed.stdout.trim().replace(/^refs\/remotes\//, "");
    // See `defaultRemoteBase`: an incomplete listing cannot veto the pointer.
    if (name && (listing.incomplete !== undefined || listing.refs.some((ref) => ref.kind === "remote" && ref.name === name))) return name;
  }
  for (const guess of ["origin/main", "origin/master"]) {
    if (listing.refs.some((ref) => ref.kind === "remote" && ref.name === guess)) return guess;
  }
  return undefined;
}

export async function gitOverviewAsync(git: AsyncGitRunner, projectRoot: string): Promise<GitOverview> {
  const inside = await git(projectRoot, ["rev-parse", "--is-inside-work-tree"]);
  refuseTimedOutProbe(inside, "Git overview");
  if (inside.status !== 0 || inside.stdout.trim() !== "true") return EMPTY;
  const head = await git(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const raw = head.status === 0 ? head.stdout.trim() : "";
  const branch = raw && raw !== "HEAD" ? raw : undefined;

  const status = await git(projectRoot, ["status", "--porcelain"]);
  const dirtyFiles = status.timedOut ? undefined : status.status === 0 ? countDirty(status.stdout) : 0;
  const tracking = await git(projectRoot, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
  const divergence = tracking.status === 0 ? parseAheadBehind(tracking.stdout) : undefined;

  const worktrees = await git(projectRoot, ["worktree", "list", "--porcelain"]);
  const listing = await listGitRefsAsync(git, projectRoot);
  const defaultBase = await defaultRemoteBaseAsync(git, projectRoot, listing);

  return {
    repository: true,
    ...(branch ? { branch } : {}),
    ...(dirtyFiles === undefined ? {} : { dirtyFiles }),
    ...(divergence ?? {}),
    ...(worktrees.timedOut ? {} : { worktrees: worktrees.status === 0 ? parseWorktreeList(worktrees.stdout, projectRoot) : [] }),
    refs: listing.refs,
    ...(listing.incomplete ? { refsIncomplete: listing.incomplete } : {}),
    ...(defaultBase ? { defaultBase } : {}),
  };
}