import { describe, expect, test } from "bun:test";
import {
  commitSessionWork,
  countDirty,
  gitOverview,
  GIT_LOG_FORMAT,
  parseAheadBehind,
  parseGitLog,
  parseNameStatus,
  parseNumstat,
  parseUntracked,
  parseWorktreeList,
  samePath,
  sessionDiff,
} from "../src/git";
import type { GitResult, GitRunner } from "../src/worktree";

const ok = (stdout: string): GitResult => ({ status: 0, stdout, stderr: "" });
const fail = (): GitResult => ({ status: 1, stdout: "", stderr: "fatal" });

/** A runner keyed by the first two argv words, so a test states only the
 *  commands it cares about and every other call fails like a real git would. */
function runner(replies: Record<string, GitResult>): GitRunner {
  return (_cwd, args) => replies[args.slice(0, 2).join(" ")] ?? fail();
}

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
