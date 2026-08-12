import { describe, expect, test } from "bun:test";
import { countDirty, gitOverview, parseAheadBehind, parseWorktreeList, samePath } from "../src/git";
import type { GitResult, GitRunner } from "../src/worktree";

const ok = (stdout: string): GitResult => ({ status: 0, stdout, stderr: "" });
const fail = (): GitResult => ({ status: 1, stdout: "", stderr: "fatal" });

/** A runner keyed by the first two argv words, so a test states only the
 *  commands it cares about and every other call fails like a real git would. */
function runner(replies: Record<string, GitResult>): GitRunner {
  return (_cwd, args) => replies[args.slice(0, 2).join(" ")] ?? fail();
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
