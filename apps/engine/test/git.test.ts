import { describe, expect, test } from "bun:test";
import {
  commitSessionWork,
  countDirty,
  defaultRemoteBase,
  gitOverview,
  gitOverviewAsync,
  GIT_LOG_FORMAT,
  listGitRefs,
  listGitRefsAsync,
  parseAheadBehind,
  parseGitLog,
  parseNameStatus,
  parseNumstat,
  parseUntracked,
  parseWorktreeList,
  normalizeRemote,
  projectRemoteAsync,
  samePath,
  sessionDiff,
  sessionDiffAsync,
  sessionFilePatch,
  sessionFilePatchAsync,
} from "../src/git";
import { GIT_TIMEOUT_STATUS } from "../src/worktree";
import type { AsyncGitRunner, GitResult, GitRunner } from "../src/worktree";

const ok = (stdout: string): GitResult => ({ status: 0, stdout, stderr: "" });
const fail = (): GitResult => ({ status: 1, stdout: "", stderr: "fatal" });

/**
 * A CHILD THE ENGINE KILLED, shaped exactly as `createGitRunner` reports one.
 *
 * THE POINT OF THE WHOLE SUITE BELOW. A timeout arrives as an ordinary non-zero
 * exit, so a test that only ever exercises `fail()` proves nothing about it —
 * which is how a timed-out ref listing came to be reported as a repository with
 * no branches (#650) under a green suite.
 */
const timedOut = (what = "for-each-ref"): GitResult => ({
  status: GIT_TIMEOUT_STATUS,
  stdout: "",
  stderr: `git ${what} in /repo did not finish within 30000ms and was killed`,
  timedOut: true,
});

/** A runner keyed by the first two argv words, so a test states only the
 *  commands it cares about and every other call fails like a real git would. */
function runner(replies: Record<string, GitResult>): GitRunner {
  return (_cwd, args) => replies[args.slice(0, 2).join(" ")] ?? fail();
}

/**
 * The ref listing's runner keys on the NAMESPACE, because both halves are
 * `for-each-ref --sort=-committerdate` and the two-word key above answers them
 * identically — which would hide the exact case this module got wrong: one half
 * dying while the other answers.
 */
function refsRunner(replies: Record<string, GitResult>): GitRunner {
  return (_cwd, args) => {
    if (args[0] === "for-each-ref") return replies[args[args.length - 1] ?? ""] ?? fail();
    return replies[args.slice(0, 2).join(" ")] ?? fail();
  };
}

const HEADS = "refs/heads";
const REMOTES = "refs/remotes";
const BOTH_HALVES: Record<string, GitResult> = {
  [HEADS]: ok("main\t*\nfeature-x\t\n"),
  [REMOTES]: ok("origin/main\t\norigin/HEAD\t\n"),
};

/**
 * The review's runner keys on THREE words, because `diff -z --numstat` and
 * `diff -z --name-status` are different questions with different answers — a
 * two-word key answered both with the same fixture and hid the fact that the
 * status letters were never being read.
 */
function reviewRunner(replies: Record<string, GitResult>, seen?: string[][]): GitRunner {
  return (_cwd, args) => {
    seen?.push(args);
    return replies[args.slice(0, 3).join(" ")] ?? replies[args.slice(0, 2).join(" ")] ?? fail();
  };
}

const REPO = {
  "rev-parse --is-inside-work-tree": ok("true\n"),
  "rev-parse --abbrev-ref": ok("main\n"),
  "status --porcelain": ok(""),
  "worktree list": ok("worktree /repo\nHEAD abc\nbranch refs/heads/main\n"),
};

describe("parseWorktreeList", () => {
  test("reads stanzas and strips the refs/heads prefix", () => {
    const entries = parseWorktreeList(
      "worktree /repo\nHEAD aaa\nbranch refs/heads/main\n\nworktree /wt/session-1\nHEAD bbb\nbranch refs/heads/telar/session-1\n",
      "/repo",
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ path: "/repo", basename: "repo", branch: "main", isMainCheckout: true });
    expect(entries[1]).toMatchObject({ basename: "session-1", branch: "telar/session-1", isMainCheckout: false });
  });

  test("leaves a detached checkout without a branch rather than naming it HEAD", () => {
    // A checkout with no branch is a real state; inventing a name hides it.
    const [entry] = parseWorktreeList("worktree /repo\nHEAD aaa\ndetached\n", "/repo");
    expect(entry.branch).toBeUndefined();
  });

  test("separates stanzas that arrive without a blank line between them", () => {
    const entries = parseWorktreeList("worktree /a\nbranch refs/heads/x\nworktree /b\nbranch refs/heads/y\n", "/a");
    expect(entries.map((entry) => entry.path)).toEqual(["/a", "/b"]);
  });
});

describe("countDirty", () => {
  test("counts one path per porcelain line and ignores trailing blanks", () => {
    expect(countDirty(" M src/a.ts\n?? src/b.ts\nA  src/c.ts\n")).toBe(3);
    expect(countDirty("")).toBe(0);
    expect(countDirty("\n\n")).toBe(0);
  });
});

describe("parseAheadBehind", () => {
  test("reads git's left-right order: behind first, then ahead", () => {
    expect(parseAheadBehind("2\t5\n")).toEqual({ ahead: 5, behind: 2 });
  });

  test("is undefined for output it cannot read", () => {
    expect(parseAheadBehind("")).toBeUndefined();
    expect(parseAheadBehind("nonsense")).toBeUndefined();
  });
});

describe("gitOverview", () => {
  test("reports a non-repository instead of failing", () => {
    // `envMode: "local"` supports an unversioned directory on purpose, so this
    // is a supported configuration and not an error state.
    const overview = gitOverview(runner({ "rev-parse --is-inside-work-tree": ok("false\n") }), "/plain");
    expect(overview).toEqual({ repository: false, dirtyFiles: 0, worktrees: [] });
  });

  test("reads branch, dirty count and worktrees", () => {
    const overview = gitOverview(
      runner({ ...REPO, "status --porcelain": ok(" M a.ts\n?? b.ts\n") }),
      "/repo",
    );
    expect(overview.repository).toBe(true);
    expect(overview.branch).toBe("main");
    expect(overview.dirtyFiles).toBe(2);
    expect(overview.worktrees[0].isMainCheckout).toBe(true);
  });

  test("leaves ahead/behind ABSENT when the branch has no upstream", () => {
    // Absent and zero mean different things: "no upstream to compare with"
    // versus "level with an upstream". Reporting 0/0 for the first would tell
    // the reader they are in sync with something that does not exist.
    const overview = gitOverview(runner(REPO), "/repo");
    expect(overview.ahead).toBeUndefined();
    expect(overview.behind).toBeUndefined();
  });

  test("reports divergence when there is an upstream", () => {
    const overview = gitOverview(runner({ ...REPO, "rev-list --left-right": ok("1\t3\n") }), "/repo");
    expect(overview).toMatchObject({ ahead: 3, behind: 1 });
  });

  test("drops a detached HEAD rather than reporting it as a branch name", () => {
    const overview = gitOverview(runner({ ...REPO, "rev-parse --abbrev-ref": ok("HEAD\n") }), "/repo");
    expect(overview.repository).toBe(true);
    expect(overview.branch).toBeUndefined();
  });

  test("survives a failing sub-command without losing the rest", () => {
    // `git status` can fail on a locked index while the branch is still known.
    const overview = gitOverview(runner({ ...REPO, "status --porcelain": fail() }), "/repo");
    expect(overview.branch).toBe("main");
    expect(overview.dirtyFiles).toBe(0);
  });
});

/**
 * A TIMED-OUT READ IS NOT A FACT ABOUT THE REPOSITORY — issue #650.
 *
 * Every test here drives `timedOut()` rather than `fail()`, and that is the
 * whole discipline: the two are the same exit status, so a suite that only
 * exercises the second calls this covered while the bug ships. The claims a
 * killed child must never produce are "no branches", "a clean tree", "no
 * worktrees" and "not a git repository".
 */
describe("git did not answer", () => {
  test("a timed-out half leaves the listing INCOMPLETE rather than short", () => {
    // The observed defect, exactly: locals die under load, remotes answer, and
    // the result was a shorter list that read as the whole repository.
    const listing = listGitRefs(refsRunner({ ...BOTH_HALVES, [HEADS]: timedOut() }), "/repo");
    expect(listing.incomplete).toBe("timeout");
    // What DID arrive is kept — those are still perfectly good bases.
    expect(listing.refs.map((ref) => ref.name)).toEqual(["origin/main"]);
  });

  test("an empty listing means 'no branches' ONLY when nothing failed", () => {
    // The three cases the old `return []` collapsed into one.
    expect(listGitRefs(refsRunner({ [HEADS]: ok(""), [REMOTES]: ok("") }), "/repo")).toEqual({ refs: [] });
    expect(listGitRefs(refsRunner({ [HEADS]: timedOut(), [REMOTES]: ok("") }), "/repo").incomplete).toBe("timeout");
    expect(listGitRefs(refsRunner({ [HEADS]: fail(), [REMOTES]: ok("") }), "/repo").incomplete).toBe("failed");
  });

  test("a timeout outranks a plain failure, because it is the one a retry fixes", () => {
    const listing = listGitRefs(refsRunner({ [HEADS]: fail(), [REMOTES]: timedOut() }), "/repo");
    expect(listing.incomplete).toBe("timeout");
  });

  test("the overview carries the incompleteness to the picker", () => {
    const overview = gitOverview(refsRunner({ ...REPO, ...BOTH_HALVES, [REMOTES]: timedOut() }), "/repo");
    expect(overview.refsIncomplete).toBe("timeout");
    expect((overview.refs ?? []).map((ref) => ref.name)).toEqual(["main", "feature-x"]);
    // And a whole listing says nothing, so the picker's ordinary state is quiet.
    expect(gitOverview(refsRunner({ ...REPO, ...BOTH_HALVES }), "/repo").refsIncomplete).toBeUndefined();
  });

  test("an incomplete listing cannot veto origin/HEAD, so the default base survives", () => {
    // The quieter half of the same bug: `defaultBase` corroborates the pointer
    // against the refs, so a dead remote half silently dropped the default and
    // the composer fell back to HEAD without anyone being told.
    const git = refsRunner({ "symbolic-ref -q": ok("refs/remotes/origin/main\n") });
    expect(defaultRemoteBase(git, "/repo", { refs: [], incomplete: "timeout" })).toBe("origin/main");
    // With a WHOLE listing the corroboration still holds — a stale pointer to a
    // deleted branch must not seed every worktree with a failing ref.
    expect(defaultRemoteBase(git, "/repo", { refs: [] })).toBeUndefined();
  });

  test("a killed `git status` leaves the dirty count ABSENT, never a reassuring 0", () => {
    const overview = gitOverview(runner({ ...REPO, "status --porcelain": timedOut("status") }), "/repo");
    expect(overview.dirtyFiles).toBeUndefined();
    // A plain failure keeps the pinned decision above: a locked index is usually
    // a clean tree, and that case is not this one.
    expect(gitOverview(runner({ ...REPO, "status --porcelain": fail() }), "/repo").dirtyFiles).toBe(0);
  });

  test("a killed `worktree list` leaves the worktrees ABSENT, never '0 worktrees'", () => {
    expect(gitOverview(runner({ ...REPO, "worktree list": timedOut("worktree list") }), "/repo").worktrees).toBeUndefined();
    expect(gitOverview(runner({ ...REPO, "worktree list": fail() }), "/repo").worktrees).toEqual([]);
  });

  test("a killed probe is refused, not reported as an unversioned directory", () => {
    // `envMode: "local"` makes "not a repository" a SUPPORTED state, which is
    // why reporting it wrongly is so quiet — the foot just says so and stops.
    // Same refusal `files.ts` makes for the file listing.
    const stalled = runner({ "rev-parse --is-inside-work-tree": timedOut("rev-parse") });
    expect(() => gitOverview(stalled, "/repo")).toThrow("did not finish within");
    expect(() => sessionDiff(stalled, { cwd: "/repo" })).toThrow("did not finish within");
    // A genuine `false` is still answered rather than thrown.
    expect(gitOverview(runner({ "rev-parse --is-inside-work-tree": ok("false\n") }), "/plain").repository).toBe(false);
  });

  test("a killed probe does not tell someone their checkout is unversioned before a commit", () => {
    const reason = commitSessionWork(runner({ "rev-parse --is-inside-work-tree": timedOut("rev-parse") }), {
      cwd: "/repo",
      message: "x",
    }).reason;
    expect(reason).not.toContain("not a git repository");
    expect(reason).toContain("git did not answer");
  });

  test("the async twins answer identically on the timeout path", async () => {
    const sync = refsRunner({ ...BOTH_HALVES, [HEADS]: timedOut() });
    const async: AsyncGitRunner = async (cwd, args) => sync(cwd, args);
    expect(await listGitRefsAsync(async, "/repo")).toEqual(listGitRefs(sync, "/repo"));

    const stalledSync = runner({ "rev-parse --is-inside-work-tree": timedOut("rev-parse") });
    const stalledAsync: AsyncGitRunner = async (cwd, args) => stalledSync(cwd, args);
    await expect(gitOverviewAsync(stalledAsync, "/repo")).rejects.toThrow("did not finish within");
    await expect(sessionDiffAsync(stalledAsync, { cwd: "/repo" })).rejects.toThrow("did not finish within");

    const overviewSync = refsRunner({ ...REPO, ...BOTH_HALVES, [REMOTES]: timedOut() });
    const overviewAsync: AsyncGitRunner = async (cwd, args) => overviewSync(cwd, args);
    expect(await gitOverviewAsync(overviewAsync, "/repo")).toEqual(gitOverview(overviewSync, "/repo"));
  });
});

describe("samePath", () => {
  test("folds case only where the platform does", () => {
    // The defect this pins: a project registered as `.../personal/...` and a
    // `git worktree list` reporting `.../Personal/...` are the same directory
    // on macOS, and `===` said otherwise — so the project's own checkout was
    // reported as somebody else's worktree.
    expect(samePath("/a/Personal/repo", "/a/personal/repo", true)).toBe(true);
    expect(samePath("/a/Personal/repo", "/a/personal/repo", false)).toBe(false);
  });

  test("ignores a trailing separator and normalises Windows separators", () => {
    expect(samePath("/a/repo/", "/a/repo", false)).toBe(true);
    expect(samePath("C:\\a\\repo", "C:/a/repo", false)).toBe(true);
  });

  test("still distinguishes genuinely different paths", () => {
    expect(samePath("/a/repo", "/a/repo2", true)).toBe(false);
  });
});

describe("worktree identity", () => {
  test("marks the main checkout when git's casing differs from the registered root", () => {
    const [entry] = parseWorktreeList("worktree /Users/x/Projects/Personal/repo\nbranch refs/heads/main\n", "/Users/x/Projects/personal/repo");
    // Only meaningful on a case-insensitive filesystem, which is where the bug
    // was observed; the helper's own test above covers both platforms.
    expect(entry.isMainCheckout).toBe(process.platform === "darwin" || process.platform === "win32");
  });
});


// ── the session review ─────────────────────────────────────────────────────

describe("parseNumstat", () => {
  test("reads counts and paths, and a rename's three NUL fields", () => {
    // `-z` is why this is parseable at all: without it a rename arrives as the
    // brace form `src/{old => new}/f.ts`, which has to be reassembled by hand
    // and mis-parses any real path containing a brace.
    const entries = parseNumstat("12\t3\tsrc/a.ts\0" + "1\t1\t\0src/old.ts\0src/new.ts\0" + "-\t-\tlogo.png\0");
    expect(entries[0]).toEqual({ path: "src/a.ts", added: 12, removed: 3, binary: false });
    expect(entries[1]).toEqual({ path: "src/new.ts", renamedFrom: "src/old.ts", added: 1, removed: 1, binary: false });
    // A binary file reports `-` for both counts, which is ABSENT rather than
    // zero — `+0 −0` would be a measurement git never made.
    expect(entries[2]).toEqual({ path: "logo.png", binary: true });
  });
});

describe("parseNameStatus", () => {
  test("maps letters to the contract's vocabulary and takes the NEW path of a rename", () => {
    const statuses = parseNameStatus("A\0src/new.ts\0M\0src/a.ts\0D\0src/gone.ts\0R100\0src/old.ts\0src/moved.ts\0");
    expect([...statuses]).toEqual([
      ["src/new.ts", "added"],
      ["src/a.ts", "modified"],
      ["src/gone.ts", "deleted"],
      ["src/moved.ts", "renamed"],
    ]);
  });
});

describe("parseUntracked", () => {
  test("takes only the untracked entries, because everything tracked is already in the diff", () => {
    // Reading tracked paths here as well would double every row.
    expect(parseUntracked(" M src/a.ts\0?? dist/app.js\0?? notes.md\0")).toEqual(["dist/app.js", "notes.md"]);
  });
});

describe("parseGitLog", () => {
  test("splits on separators git will not emit itself, and converts seconds to milliseconds", () => {
    // A commit subject may contain any printable character, including tabs —
    // which is why the format uses these separators rather than something typeable.
    const record = ["abc123def", "abc123d", "fix: tab\there", "1700000000", "Ada"].join("\x1f") + "\x1e";
    expect(parseGitLog(record)).toEqual([
      { sha: "abc123def", shortSha: "abc123d", subject: "fix: tab\there", at: 1_700_000_000_000, author: "Ada" },
    ]);
  });
});

/** `git log`'s key carries the whole format string, so it is built from the
 *  module's own constant rather than typed out — a change to the format must
 *  not silently make this fixture stop matching. */
const LOG_KEY = `log --format=${GIT_LOG_FORMAT}`;

const REVIEW: Record<string, GitResult> = {
  "rev-parse --is-inside-work-tree": ok("true\n"),
  "rev-parse --abbrev-ref": ok("session/fix\n"),
  "rev-parse --verify": ok("base000\n"),
  "diff -z --numstat": ok("4\t1\tsrc/a.ts\0"),
  "diff -z --name-status": ok("M\0src/a.ts\0"),
  "status --porcelain": ok("?? dist/app.js\0"),
  [LOG_KEY]: ok(["sha1", "sha1sho", "did the thing", "1700000000", "Ada"].join("\x1f") + "\x1e"),
  "rev-list --left-right": ok("0\t2\n"),
};

describe("sessionDiff", () => {
  test("covers committed and uncommitted work together, and untracked files the diff cannot see", () => {
    // The whole reason this exists: `git status` forgets a change the moment the
    // agent commits it, and a branch comparison forgets everything uncommitted.
    const diff = sessionDiff(reviewRunner(REVIEW), { cwd: "/repo", baseRef: "base000" });
    expect(diff.repository).toBe(true);
    expect(diff.base).toBe("base000");
    expect(diff.branch).toBe("session/fix");
    expect(diff.files.map((file) => file.path)).toEqual(["dist/app.js", "src/a.ts"]);
    // Untracked files are absent from `git diff` entirely — a review built from
    // the diff alone misses every file a scaffolding run created.
    expect(diff.files.find((file) => file.path === "dist/app.js")?.status).toBe("untracked");
    expect(diff.commits).toHaveLength(1);
    expect({ ahead: diff.ahead, behind: diff.behind }).toEqual({ ahead: 2, behind: 0 });
    expect({ added: diff.linesAdded, removed: diff.linesRemoved }).toEqual({ added: 4, removed: 1 });
  });

  test("a base that no longer resolves falls back to HEAD rather than failing", () => {
    // A worktree's base can genuinely disappear — an upstream rebase, a gc — and
    // every command would then fail with the same opaque "bad revision".
    const diff = sessionDiff(reviewRunner({ ...REVIEW, "rev-parse --verify": fail() }), { cwd: "/repo", baseRef: "gone" });
    expect(diff.base).toBeUndefined();
    // Without a base there is no commit range to ask about, so committed work is
    // not counted — and the surface says so rather than implying completeness.
    expect(diff.commits).toEqual([]);
  });

  test("a directory that is not a repository is answered, not thrown", () => {
    // `envMode: "local"` exists precisely so an unversioned directory can host
    // sessions.
    expect(sessionDiff(runner({}), { cwd: "/tmp/notes" })).toMatchObject({ repository: false, files: [], commits: [] });
  });

  test("untracked files are listed one by one, not collapsed into a directory row", () => {
    // MEASURED AGAINST A REAL REPOSITORY: without `-uall`, five new files under
    // two new directories arrived as two rows reading `app/api/…/diff/` — rows
    // nobody can open, count or judge.
    const seen: string[][] = [];
    sessionDiff(reviewRunner(REVIEW, seen), { cwd: "/repo", baseRef: "base000" });
    const status = seen.find((args) => args[0] === "status");
    expect(status).toContain("-uall");
  });

  test("the status letters come from name-status, not from the numstat fixture", () => {
    const diff = sessionDiff(
      reviewRunner({ ...REVIEW, "diff -z --name-status": ok("D\0src/a.ts\0") }),
      { cwd: "/repo", baseRef: "base000" },
    );
    expect(diff.files.find((file) => file.path === "src/a.ts")?.status).toBe("deleted");
  });
});

/**
 * A TIMED-OUT DIFF IS NOT "THIS SESSION CHANGED NOTHING" — issue #654.
 *
 * Every test here drives `timedOut()` and never `fail()` alone, for the reason
 * #650's suite gives: the two are the SAME EXIT STATUS, so a test exercising a
 * generic non-zero exit would call this covered while the bug shipped. What no
 * killed read may produce is an empty review, an empty commit list, a base
 * reported as unrecorded, or a patch that reads as a binary file.
 *
 * WORSE HERE THAN IN THE REF LISTING, which is why it got its own issue: an
 * empty diff is a claim a person acts on directly — it is how you decide a
 * session did nothing and archive it — and `sessions_diff` is read by AGENTS,
 * which will report it onward as fact.
 */
describe("git did not answer about the diff", () => {
  const base = { cwd: "/repo", baseRef: "base000" };

  test("a killed numstat leaves the review INCOMPLETE rather than empty, and keeps the untracked half", () => {
    // The shape that matters: one read dies, the others answer, and the result
    // was a SHORTER review that read as the whole change.
    const diff = sessionDiff(reviewRunner({ ...REVIEW, "diff -z --numstat": timedOut("diff --numstat") }), base);
    expect(diff.filesIncomplete).toBe("timeout");
    // What DID arrive is kept — those are real changes, about to be committed.
    expect(diff.files.map((file) => file.path)).toEqual(["dist/app.js"]);
  });

  test("a killed `git status` loses every untracked file, which for a scaffolding run is all of them", () => {
    const diff = sessionDiff(reviewRunner({ ...REVIEW, "status --porcelain": timedOut("status") }), base);
    expect(diff.filesIncomplete).toBe("timeout");
    expect(diff.files.map((file) => file.path)).toEqual(["src/a.ts"]);
  });

  test("a killed name-status marks the review too, because every letter becomes a guess", () => {
    // The rows are all there; their statuses are not. A row claiming "modified"
    // about a file git deleted is a wrong claim about that file.
    const diff = sessionDiff(reviewRunner({ ...REVIEW, "diff -z --name-status": timedOut("diff --name-status") }), base);
    expect(diff.filesIncomplete).toBe("timeout");
    expect(diff.files).toHaveLength(2);
  });

  test("an empty review means 'nothing changed' ONLY when nothing failed", () => {
    // The three cases the old `status !== 0 ? []` collapsed into one.
    const quiet = { ...REVIEW, "diff -z --numstat": ok(""), "diff -z --name-status": ok(""), "status --porcelain": ok("") };
    const nothing = sessionDiff(reviewRunner(quiet), base);
    expect(nothing.files).toEqual([]);
    expect(nothing.filesIncomplete).toBeUndefined();
    expect(sessionDiff(reviewRunner({ ...quiet, "diff -z --numstat": timedOut() }), base).filesIncomplete).toBe("timeout");
    // A plain failure is marked too, unlike `gitOverview`'s pinned dirty count:
    // that decision was about a COUNT on the composer's foot, and this is the
    // list somebody is about to commit.
    expect(sessionDiff(reviewRunner({ ...quiet, "diff -z --numstat": fail() }), base).filesIncomplete).toBe("failed");
  });

  test("a killed `rev-parse --verify` cannot veto the base the session recorded", () => {
    /**
     * THE QUIET HALF OF #654, and the analogue of #650's `defaultRemoteBase`
     * fix. The base comes from the session record; the verify is corroboration.
     * Dropping it on a timeout silently reframes the review as `HEAD…worktree`
     * — which excludes every commit the session made, so a session that
     * COMMITTED all of its work reads as having done none of it, under a
     * sentence ("no starting commit was recorded") that is itself false.
     */
    const diff = sessionDiff(reviewRunner({ ...REVIEW, "rev-parse --verify": timedOut("rev-parse --verify") }), base);
    expect(diff.base).toBe("base000");
    expect(diff.baseUnverified).toBe("timeout");
    // And the range is still asked about, so committed work is still counted.
    expect(diff.commits).toHaveLength(1);
  });

  test("a base that genuinely does not resolve is still dropped, unmarked", () => {
    // The pinned decision this must not have broken: `--verify --quiet` exiting
    // non-zero IS the answer "that ref is gone", and falling back to HEAD gives
    // a smaller TRUE answer rather than an error nobody can act on.
    const diff = sessionDiff(reviewRunner({ ...REVIEW, "rev-parse --verify": fail() }), { cwd: "/repo", baseRef: "gone" });
    expect(diff.base).toBeUndefined();
    expect(diff.baseUnverified).toBeUndefined();
  });

  test("a killed `git log` marks the COMMITS and says nothing about the files", () => {
    // The whole reason there are three channels and not one: a reader should
    // distrust the half of the screen that is actually unknown.
    const diff = sessionDiff(reviewRunner({ ...REVIEW, [LOG_KEY]: timedOut("log") }), base);
    expect(diff.commitsIncomplete).toBe("timeout");
    expect(diff.commits).toEqual([]);
    expect(diff.filesIncomplete).toBeUndefined();
    expect(diff.files).toHaveLength(2);
  });

  test("no base is not a failed log, so nothing is marked", () => {
    // There is no range to ask about, which the surface already explains with
    // `base` absent — marking it as well would invent a git failure.
    const diff = sessionDiff(reviewRunner(REVIEW), { cwd: "/repo" });
    expect(diff.commits).toEqual([]);
    expect(diff.commitsIncomplete).toBeUndefined();
  });

  test("a whole review says nothing at all, so the ordinary surface stays quiet", () => {
    const diff = sessionDiff(reviewRunner(REVIEW), base);
    expect(diff.filesIncomplete).toBeUndefined();
    expect(diff.commitsIncomplete).toBeUndefined();
    expect(diff.baseUnverified).toBeUndefined();
  });

  test("a killed patch is marked, not returned as an empty one that reads as 'binary file'", () => {
    // `patch: ""` meant two things, and the surfaces drew the second as the
    // first: an empty non-binary patch renders as "Binary file — no textual
    // diff", so a killed subprocess told the reader something specific and
    // wrong about the file's CONTENTS.
    const killed = sessionFilePatch(reviewRunner({ ...REVIEW, "diff --unified=3": timedOut("diff") }), { ...base, path: "src/a.ts" });
    expect(killed).toEqual({ patch: "", binary: false, incomplete: "timeout" });
    const broken = sessionFilePatch(reviewRunner({ ...REVIEW, "diff --unified=3": { status: 128, stdout: "", stderr: "fatal" } }), {
      ...base,
      path: "src/a.ts",
    });
    expect(broken.incomplete).toBe("failed");
    // Exit 1 is `--no-index` reporting a difference, which is this command's
    // SUCCESS — it must not land in the new channel.
    const differs = sessionFilePatch(reviewRunner({ ...REVIEW, "diff --no-index": { status: 1, stdout: "@@ -0,0 +1 @@\n+new\n", stderr: "" } }), {
      ...base,
      path: "dist/app.js",
      untracked: true,
    });
    expect(differs.incomplete).toBeUndefined();
    expect(differs.patch).toContain("+new");
  });

  test("the async twins answer identically on every one of these paths", async () => {
    for (const replies of [
      { ...REVIEW, "diff -z --numstat": timedOut("diff --numstat") },
      { ...REVIEW, "rev-parse --verify": timedOut("rev-parse --verify") },
      { ...REVIEW, [LOG_KEY]: timedOut("log") },
      { ...REVIEW, "status --porcelain": timedOut("status") },
    ]) {
      const sync = reviewRunner(replies);
      const async: AsyncGitRunner = async (cwd, args) => sync(cwd, args);
      expect(await sessionDiffAsync(async, base)).toEqual(sessionDiff(sync, base));
    }

    const patchSync = reviewRunner({ ...REVIEW, "diff --unified=3": timedOut("diff") });
    const patchAsync: AsyncGitRunner = async (cwd, args) => patchSync(cwd, args);
    expect(await sessionFilePatchAsync(patchAsync, { ...base, path: "src/a.ts" })).toEqual(
      sessionFilePatch(patchSync, { ...base, path: "src/a.ts" }),
    );
  });
});

/**
 * IGNORING WHITESPACE IS A DIFFERENT COMMAND, NOT A DIFFERENT RENDERING — #694.
 *
 * The toolbar toggle looks like a view option and is not one: git decides which
 * hunks exist before any of the patch reaches a client, so the flag has to be on
 * the command. These assert the ARGUMENT, because that is the whole of the
 * change and the only part a fixture can see.
 */
describe("sessionFilePatch, ignoring whitespace", () => {
  /** Records what git was asked, and answers a patch to every diff. */
  function recording(): { runner: GitRunner; calls: string[][] } {
    const calls: string[][] = [];
    const runner: GitRunner = (_cwd, args) => {
      calls.push(args);
      if (args[0] === "rev-parse") return ok("");
      return ok("@@ -1 +1 @@\n-a\n+b\n");
    };
    return { runner, calls };
  }

  test("off by default — the ordinary read is unchanged", () => {
    const { runner, calls } = recording();
    sessionFilePatch(runner, { cwd: "/repo", path: "src/a.ts" });
    expect(calls.at(-1)).toEqual(["diff", "--unified=3", "HEAD", "--", "src/a.ts"]);
  });

  test("on, the command carries -w AND --ignore-blank-lines", () => {
    // Either alone leaves the toggle half-true: `-w` keeps a hunk whose only
    // change is an inserted blank line, which is the same noise to the person
    // who asked for the noise to go.
    const { runner, calls } = recording();
    sessionFilePatch(runner, { cwd: "/repo", path: "src/a.ts", ignoreWhitespace: true });
    expect(calls.at(-1)).toEqual(["diff", "--unified=3", "-w", "--ignore-blank-lines", "HEAD", "--", "src/a.ts"]);
  });

  test("an untracked file ignores whitespace too, against /dev/null", () => {
    // The `--no-index` branch is a whole separate command line, so it is the
    // one that quietly keeps working while doing nothing.
    const { runner, calls } = recording();
    sessionFilePatch(runner, { cwd: "/repo", path: "dist/app.js", untracked: true, ignoreWhitespace: true });
    expect(calls.at(-1)).toEqual(["diff", "--no-index", "--unified=3", "-w", "--ignore-blank-lines", "--", "/dev/null", "dist/app.js"]);
  });

  test("the flag goes AFTER --unified=3 and BEFORE the base, so the base is still a base", () => {
    // `git diff [options] <commit> -- <path>`: an option between the commit and
    // the pathspec separator would be parsed as a second revision.
    const { runner, calls } = recording();
    sessionFilePatch(runner, { cwd: "/repo", baseRef: "abc1234", path: "src/a.ts", ignoreWhitespace: true });
    const args = calls.at(-1)!;
    expect(args.indexOf("-w")).toBeLessThan(args.indexOf("abc1234"));
    expect(args.indexOf("abc1234")).toBeLessThan(args.indexOf("--"));
  });

  test("the async twin sends the same argument list", async () => {
    const sync = recording();
    const async = recording();
    const asyncRunner: AsyncGitRunner = async (cwd, args) => async.runner(cwd, args);
    const input = { cwd: "/repo", path: "src/a.ts", ignoreWhitespace: true } as const;
    sessionFilePatch(sync.runner, input);
    await sessionFilePatchAsync(asyncRunner, input);
    expect(async.calls).toEqual(sync.calls);
  });
});

describe("commitSessionWork", () => {
  test("stages everything, then commits, and reports the new commit", () => {
    const calls: string[][] = [];
    const git: GitRunner = (_cwd, args) => {
      calls.push(args);
      const key = args.slice(0, 2).join(" ");
      if (key === "rev-parse --is-inside-work-tree") return ok("true\n");
      if (key === "add -A") return ok("");
      // Non-zero from `diff --cached --quiet` means there IS something staged.
      if (key === "diff --cached") return fail();
      if (key === "commit -m") return ok("");
      if (key === "log -1") return ok(["sha1", "sha1sho", "Session work", "1700000000", "Ada"].join("\x1f") + "\x1e");
      return fail();
    };
    const result = commitSessionWork(git, { cwd: "/repo", message: "Session work" });
    expect(result.committed).toBe(true);
    expect(result.commit?.shortSha).toBe("sha1sho");
    // `add -A` rather than a staging UI: you did not write these changes, so
    // "which hunks" is bookkeeping for authorship you do not have.
    expect(calls.some((args) => args[0] === "add" && args[1] === "-A")).toBe(true);
  });

  test("a clean tree is an answer, not a failure", () => {
    // The ordinary state after a session that only read. A red error here would
    // teach the reader to distrust the button.
    const git: GitRunner = (_cwd, args) => {
      const key = args.slice(0, 2).join(" ");
      if (key === "rev-parse --is-inside-work-tree") return ok("true\n");
      if (key === "add -A") return ok("");
      if (key === "diff --cached") return ok("");
      return fail();
    };
    expect(commitSessionWork(git, { cwd: "/repo", message: "x" })).toMatchObject({ committed: false });
  });

  test("a hook that refuses is passed through in its own words", () => {
    const git: GitRunner = (_cwd, args) => {
      const key = args.slice(0, 2).join(" ");
      if (key === "rev-parse --is-inside-work-tree") return ok("true\n");
      if (key === "add -A") return ok("");
      if (key === "diff --cached") return fail();
      if (key === "commit -m") return { status: 1, stdout: "", stderr: "pre-commit: lint failed on 3 files\n" };
      return fail();
    };
    // Its own output is the only useful thing to show; a generic failure would
    // send the reader to a terminal to find out what this already knew.
    expect(commitSessionWork(git, { cwd: "/repo", message: "x" }).reason).toBe("pre-commit: lint failed on 3 files");
  });
});


/**
 * WHICH REPOSITORY A CHECKOUT IS OF — the comparison two Macs' rails are merged
 * on, so what matters here is that every spelling of one repository reduces to
 * one string, and that nothing reduces two repositories to one.
 */
describe("normalizeRemote", () => {
  test("every spelling of one repository is one string", () => {
    const spellings = [
      "git@github.com:Facundo-Barbera/telar.git",
      "git@github.com:Facundo-Barbera/telar",
      "https://github.com/Facundo-Barbera/telar.git",
      "https://github.com/Facundo-Barbera/telar",
      "https://github.com/Facundo-Barbera/telar/",
      "ssh://git@github.com:22/Facundo-Barbera/telar.git",
      "ssh://git@github.com/Facundo-Barbera/telar.git",
      "git://github.com/Facundo-Barbera/telar.git",
      "  https://github.com/facundo-barbera/telar.git\n",
    ];
    for (const spelling of spellings) {
      expect([spelling, normalizeRemote(spelling)]).toEqual([spelling, "github.com/facundo-barbera/telar"]);
    }
  });

  test("credentials in the authority never survive — this value travels to another Mac", () => {
    expect(normalizeRemote("https://facundo:ghp_secrettoken@github.com/owner/repo.git")).toBe("github.com/owner/repo");
    expect(normalizeRemote("https://x-access-token:ghs_abc@github.com/owner/repo")).toBe("github.com/owner/repo");
  });

  test("a self-hosted forge keeps its whole path, so two groups under one host stay two", () => {
    expect(normalizeRemote("git@gitlab.example.com:team/sub/thing.git")).toBe("gitlab.example.com/team/sub/thing");
    expect(normalizeRemote("https://gitlab.example.com/team/sub/thing.git")).toBe("gitlab.example.com/team/sub/thing");
    expect(normalizeRemote("git@gitlab.example.com:team/other.git")).not.toBe(normalizeRemote("git@gitlab.example.com:team/thing.git"));
  });

  test("two different repositories never collide", () => {
    expect(normalizeRemote("git@github.com:owner/repo.git")).not.toBe(normalizeRemote("git@github.com:other/repo.git"));
    expect(normalizeRemote("git@github.com:owner/repo.git")).not.toBe(normalizeRemote("git@gitlab.com:owner/repo.git"));
  });

  test("a remote that names a disk rather than a host is no answer at all", () => {
    // Two Macs both cloning /Users/me/repos/thing.git are two disks — merging
    // their rails on a matching path would be the one mistake this must not make.
    for (const path of ["/srv/git/thing.git", "file:///srv/git/thing.git", "../sibling", "~/repos/thing.git", "."]) {
      expect([path, normalizeRemote(path)]).toEqual([path, undefined]);
    }
  });

  test("no origin, an empty answer and whitespace are all absent rather than empty", () => {
    expect(normalizeRemote(undefined)).toBeUndefined();
    expect(normalizeRemote("")).toBeUndefined();
    expect(normalizeRemote("   \n")).toBeUndefined();
    expect(normalizeRemote("https://github.com/")).toBeUndefined();
    expect(normalizeRemote("git@github.com:.git")).toBeUndefined();
  });

  test("projectRemoteAsync reads origin, and a checkout without one says nothing", async () => {
    const withOrigin: AsyncGitRunner = async (_cwd, args) =>
      args.join(" ") === "config --get remote.origin.url" ? ok("git@github.com:owner/Repo.git\n") : fail();
    expect(await projectRemoteAsync(withOrigin, "/repo")).toBe("github.com/owner/repo");
    expect(await projectRemoteAsync(async () => fail(), "/not-a-repo")).toBeUndefined();
  });
});
