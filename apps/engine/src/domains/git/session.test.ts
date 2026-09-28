import { describe, expect, test } from "bun:test";
import { commitSessionWork } from "./push";
import { countDirty, GIT_LOG_FORMAT, parseAheadBehind, parseGitLog, parseNameStatus, parseNumstat, parseUntracked, parseWorktreeList, samePath } from "../../platform/git/parse";
import { defaultRemoteBaseAsync, gitOverviewAsync, listGitRefsAsync, normalizeRemote, projectRemoteAsync, sessionDiffAsync, sessionFilePatchAsync } from "./session";
import { GIT_TIMEOUT_STATUS } from "../../platform/git/runner";
import type { AsyncGitRunner, GitResult, GitRunner } from "../../platform/git/runner";

const toAsync = (git: GitRunner): AsyncGitRunner => async (cwd, args, options) => git(cwd, args, options);

const ok = (stdout: string): GitResult => ({ status: 0, stdout, stderr: "" });
const fail = (): GitResult => ({ status: 1, stdout: "", stderr: "fatal" });

const timedOut = (what = "for-each-ref"): GitResult => ({
  status: GIT_TIMEOUT_STATUS,
  stdout: "",
  stderr: `git ${what} in /repo did not finish within 30000ms and was killed`,
  timedOut: true,
});

function subcommand(args: string[]): string[] {
  let index = 0;
  while (args[index] === "-c") index += 2;
  return args.slice(index);
}

function runner(replies: Record<string, GitResult>): GitRunner {
  return (_cwd, args) => replies[subcommand(args).slice(0, 2).join(" ")] ?? fail();
}

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

function reviewRunner(replies: Record<string, GitResult>, seen?: string[][]): GitRunner {
  return (_cwd, args) => {
    seen?.push(args);
    const verb = subcommand(args);
    return replies[verb.slice(0, 3).join(" ")] ?? replies[verb.slice(0, 2).join(" ")] ?? fail();
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
  test("reports a non-repository instead of failing", async () => {
    const overview = await gitOverviewAsync(toAsync(runner({ "rev-parse --is-inside-work-tree": ok("false\n") })), "/plain");
    expect(overview).toEqual({ repository: false, dirtyFiles: 0, worktrees: [] });
  });

  test("reads branch, dirty count and worktrees", async () => {
    const overview = await gitOverviewAsync(toAsync(
      runner({ ...REPO, "status --porcelain": ok(" M a.ts\n?? b.ts\n") })),
      "/repo",
    );
    expect(overview.repository).toBe(true);
    expect(overview.branch).toBe("main");
    expect(overview.dirtyFiles).toBe(2);
    expect(overview.worktrees![0].isMainCheckout).toBe(true);
  });

  test("leaves ahead/behind ABSENT when the branch has no upstream", async () => {
    const overview = await gitOverviewAsync(toAsync(runner(REPO)), "/repo");
    expect(overview.ahead).toBeUndefined();
    expect(overview.behind).toBeUndefined();
  });

  test("reports divergence when there is an upstream", async () => {
    const overview = await gitOverviewAsync(toAsync(runner({ ...REPO, "rev-list --left-right": ok("1\t3\n") })), "/repo");
    expect(overview).toMatchObject({ ahead: 3, behind: 1 });
  });

  test("drops a detached HEAD rather than reporting it as a branch name", async () => {
    const overview = await gitOverviewAsync(toAsync(runner({ ...REPO, "rev-parse --abbrev-ref": ok("HEAD\n") })), "/repo");
    expect(overview.repository).toBe(true);
    expect(overview.branch).toBeUndefined();
  });

  test("survives a failing sub-command without losing the rest", async () => {
    const overview = await gitOverviewAsync(toAsync(runner({ ...REPO, "status --porcelain": fail() })), "/repo");
    expect(overview.branch).toBe("main");
    expect(overview.dirtyFiles).toBe(0);
  });
});

describe("git did not answer", () => {
  test("a timed-out half leaves the listing INCOMPLETE rather than short", async () => {
    const listing = await listGitRefsAsync(toAsync(refsRunner({ ...BOTH_HALVES, [HEADS]: timedOut() })), "/repo");
    expect(listing.incomplete).toBe("timeout");
    expect(listing.refs.map((ref) => ref.name)).toEqual(["origin/main"]);
  });

  test("an empty listing means 'no branches' ONLY when nothing failed", async () => {
    expect(await listGitRefsAsync(toAsync(refsRunner({ [HEADS]: ok(""), [REMOTES]: ok("") })), "/repo")).toEqual({ refs: [] });
    expect((await listGitRefsAsync(toAsync(refsRunner({ [HEADS]: timedOut(), [REMOTES]: ok("") })), "/repo")).incomplete).toBe("timeout");
    expect((await listGitRefsAsync(toAsync(refsRunner({ [HEADS]: fail(), [REMOTES]: ok("") })), "/repo")).incomplete).toBe("failed");
  });

  test("a timeout outranks a plain failure, because it is the one a retry fixes", async () => {
    const listing = await listGitRefsAsync(toAsync(refsRunner({ [HEADS]: fail(), [REMOTES]: timedOut() })), "/repo");
    expect(listing.incomplete).toBe("timeout");
  });

  test("the overview carries the incompleteness to the picker", async () => {
    const overview = await gitOverviewAsync(toAsync(refsRunner({ ...REPO, ...BOTH_HALVES, [REMOTES]: timedOut() })), "/repo");
    expect(overview.refsIncomplete).toBe("timeout");
    expect((overview.refs ?? []).map((ref) => ref.name)).toEqual(["main", "feature-x"]);
    expect((await gitOverviewAsync(toAsync(refsRunner({ ...REPO, ...BOTH_HALVES })), "/repo")).refsIncomplete).toBeUndefined();
  });

  test("an incomplete listing cannot veto origin/HEAD, so the default base survives", async () => {
    const git = refsRunner({ "symbolic-ref -q": ok("refs/remotes/origin/main\n") });
    expect(await defaultRemoteBaseAsync(toAsync(git), "/repo", { refs: [], incomplete: "timeout" })).toBe("origin/main");
    expect(await defaultRemoteBaseAsync(toAsync(git), "/repo", { refs: [] })).toBeUndefined();
  });

  test("a killed `git status` leaves the dirty count ABSENT, never a reassuring 0", async () => {
    const overview = await gitOverviewAsync(toAsync(runner({ ...REPO, "status --porcelain": timedOut("status") })), "/repo");
    expect(overview.dirtyFiles).toBeUndefined();
    expect((await gitOverviewAsync(toAsync(runner({ ...REPO, "status --porcelain": fail() })), "/repo")).dirtyFiles).toBe(0);
  });

  test("a killed `worktree list` leaves the worktrees ABSENT, never '0 worktrees'", async () => {
    expect((await gitOverviewAsync(toAsync(runner({ ...REPO, "worktree list": timedOut("worktree list") })), "/repo")).worktrees).toBeUndefined();
    expect((await gitOverviewAsync(toAsync(runner({ ...REPO, "worktree list": fail() })), "/repo")).worktrees).toEqual([]);
  });

  test("a killed probe is refused, not reported as an unversioned directory", async () => {
    const stalled = runner({ "rev-parse --is-inside-work-tree": timedOut("rev-parse") });
    await expect(gitOverviewAsync(toAsync(stalled), "/repo")).rejects.toThrow("did not finish within");
    await expect(sessionDiffAsync(toAsync(stalled), { cwd: "/repo" })).rejects.toThrow("did not finish within");
    expect((await gitOverviewAsync(toAsync(runner({ "rev-parse --is-inside-work-tree": ok("false\n") })), "/plain")).repository).toBe(false);
  });

  test("a killed probe does not tell someone their checkout is unversioned before a commit", async () => {
    const stalled = runner({ "rev-parse --is-inside-work-tree": timedOut("rev-parse") });
    const reason = (await commitSessionWork(async (cwd, args) => stalled(cwd, args), {
      cwd: "/repo",
      message: "x",
    })).reason;
    expect(reason).not.toContain("not a git repository");
    expect(reason).toContain("git did not answer");
  });

  test("the async twins answer identically on the timeout path", async () => {
    const sync = refsRunner({ ...BOTH_HALVES, [HEADS]: timedOut() });
    const async: AsyncGitRunner = async (cwd, args) => sync(cwd, args);
    expect(await listGitRefsAsync(async, "/repo")).toEqual(await listGitRefsAsync(toAsync(sync), "/repo"));

    const stalledSync = runner({ "rev-parse --is-inside-work-tree": timedOut("rev-parse") });
    const stalledAsync: AsyncGitRunner = async (cwd, args) => stalledSync(cwd, args);
    await expect(gitOverviewAsync(stalledAsync, "/repo")).rejects.toThrow("did not finish within");
    await expect(sessionDiffAsync(stalledAsync, { cwd: "/repo" })).rejects.toThrow("did not finish within");

    const overviewSync = refsRunner({ ...REPO, ...BOTH_HALVES, [REMOTES]: timedOut() });
    const overviewAsync: AsyncGitRunner = async (cwd, args) => overviewSync(cwd, args);
    expect(await gitOverviewAsync(overviewAsync, "/repo")).toEqual(await gitOverviewAsync(toAsync(overviewSync), "/repo"));
  });
});

describe("samePath", () => {
  test("folds case only where the platform does", () => {
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
    expect(entry.isMainCheckout).toBe(process.platform === "darwin" || process.platform === "win32");
  });
});

describe("parseNumstat", () => {
  test("reads counts and paths, and a rename's three NUL fields", () => {
    const entries = parseNumstat("12\t3\tsrc/a.ts\0" + "1\t1\t\0src/old.ts\0src/new.ts\0" + "-\t-\tlogo.png\0");
    expect(entries[0]).toEqual({ path: "src/a.ts", added: 12, removed: 3, binary: false });
    expect(entries[1]).toEqual({ path: "src/new.ts", renamedFrom: "src/old.ts", added: 1, removed: 1, binary: false });
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
    expect(parseUntracked(" M src/a.ts\0?? dist/app.js\0?? notes.md\0")).toEqual(["dist/app.js", "notes.md"]);
  });
});

describe("parseGitLog", () => {
  test("splits on separators git will not emit itself, and converts seconds to milliseconds", () => {
    const record = ["abc123def", "abc123d", "fix: tab\there", "1700000000", "Ada"].join("\x1f") + "\x1e";
    expect(parseGitLog(record)).toEqual([
      { sha: "abc123def", shortSha: "abc123d", subject: "fix: tab\there", at: 1_700_000_000_000, author: "Ada" },
    ]);
  });
});

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
  test("covers committed and uncommitted work together, and untracked files the diff cannot see", async () => {
    const diff = await sessionDiffAsync(toAsync(reviewRunner(REVIEW)), { cwd: "/repo", baseRef: "base000" });
    expect(diff.repository).toBe(true);
    expect(diff.base).toBe("base000");
    expect(diff.branch).toBe("session/fix");
    expect(diff.files.map((file) => file.path)).toEqual(["dist/app.js", "src/a.ts"]);
    expect(diff.files.find((file) => file.path === "dist/app.js")?.status).toBe("untracked");
    expect(diff.commits).toHaveLength(1);
    expect({ ahead: diff.ahead, behind: diff.behind }).toEqual({ ahead: 2, behind: 0 });
    expect({ added: diff.linesAdded, removed: diff.linesRemoved }).toEqual({ added: 4, removed: 1 });
  });

  test("a base that no longer resolves falls back to HEAD rather than failing", async () => {
    const diff = await sessionDiffAsync(toAsync(reviewRunner({ ...REVIEW, "rev-parse --verify": fail() })), { cwd: "/repo", baseRef: "gone" });
    expect(diff.base).toBeUndefined();
    expect(diff.commits).toEqual([]);
  });

  test("a directory that is not a repository is answered, not thrown", async () => {
    expect(await sessionDiffAsync(toAsync(runner({})), { cwd: "/tmp/notes" })).toMatchObject({ repository: false, files: [], commits: [] });
  });

  test("untracked files are listed one by one, not collapsed into a directory row", async () => {
    const seen: string[][] = [];
    await sessionDiffAsync(toAsync(reviewRunner(REVIEW, seen)), { cwd: "/repo", baseRef: "base000" });
    const status = seen.find((args) => args[0] === "status");
    expect(status).toContain("-uall");
  });

  test("the status letters come from name-status, not from the numstat fixture", async () => {
    const diff = await sessionDiffAsync(toAsync(
      reviewRunner({ ...REVIEW, "diff -z --name-status": ok("D\0src/a.ts\0") })),
      { cwd: "/repo", baseRef: "base000" },
    );
    expect(diff.files.find((file) => file.path === "src/a.ts")?.status).toBe("deleted");
  });
});

describe("git did not answer about the diff", () => {
  const base = { cwd: "/repo", baseRef: "base000" };

  test("a killed numstat leaves the review INCOMPLETE rather than empty, and keeps the untracked half", async () => {
    const diff = await sessionDiffAsync(toAsync(reviewRunner({ ...REVIEW, "diff -z --numstat": timedOut("diff --numstat") })), base);
    expect(diff.filesIncomplete).toBe("timeout");
    expect(diff.files.map((file) => file.path)).toEqual(["dist/app.js"]);
  });

  test("a killed `git status` loses every untracked file, which for a scaffolding run is all of them", async () => {
    const diff = await sessionDiffAsync(toAsync(reviewRunner({ ...REVIEW, "status --porcelain": timedOut("status") })), base);
    expect(diff.filesIncomplete).toBe("timeout");
    expect(diff.files.map((file) => file.path)).toEqual(["src/a.ts"]);
  });

  test("a killed name-status marks the review too, because every letter becomes a guess", async () => {
    const diff = await sessionDiffAsync(toAsync(reviewRunner({ ...REVIEW, "diff -z --name-status": timedOut("diff --name-status") })), base);
    expect(diff.filesIncomplete).toBe("timeout");
    expect(diff.files).toHaveLength(2);
  });

  test("an empty review means 'nothing changed' ONLY when nothing failed", async () => {
    const quiet = { ...REVIEW, "diff -z --numstat": ok(""), "diff -z --name-status": ok(""), "status --porcelain": ok("") };
    const nothing = await sessionDiffAsync(toAsync(reviewRunner(quiet)), base);
    expect(nothing.files).toEqual([]);
    expect(nothing.filesIncomplete).toBeUndefined();
    expect((await sessionDiffAsync(toAsync(reviewRunner({ ...quiet, "diff -z --numstat": timedOut() })), base)).filesIncomplete).toBe("timeout");
    expect((await sessionDiffAsync(toAsync(reviewRunner({ ...quiet, "diff -z --numstat": fail() })), base)).filesIncomplete).toBe("failed");
  });

  test("a killed `rev-parse --verify` cannot veto the base the session recorded", async () => {
    const diff = await sessionDiffAsync(toAsync(reviewRunner({ ...REVIEW, "rev-parse --verify": timedOut("rev-parse --verify") })), base);
    expect(diff.base).toBe("base000");
    expect(diff.baseUnverified).toBe("timeout");
    expect(diff.commits).toHaveLength(1);
  });

  test("a base that genuinely does not resolve is still dropped, unmarked", async () => {
    const diff = await sessionDiffAsync(toAsync(reviewRunner({ ...REVIEW, "rev-parse --verify": fail() })), { cwd: "/repo", baseRef: "gone" });
    expect(diff.base).toBeUndefined();
    expect(diff.baseUnverified).toBeUndefined();
  });

  test("a killed `git log` marks the COMMITS and says nothing about the files", async () => {
    const diff = await sessionDiffAsync(toAsync(reviewRunner({ ...REVIEW, [LOG_KEY]: timedOut("log") })), base);
    expect(diff.commitsIncomplete).toBe("timeout");
    expect(diff.commits).toEqual([]);
    expect(diff.filesIncomplete).toBeUndefined();
    expect(diff.files).toHaveLength(2);
  });

  test("no base is not a failed log, so nothing is marked", async () => {
    const diff = await sessionDiffAsync(toAsync(reviewRunner(REVIEW)), { cwd: "/repo" });
    expect(diff.commits).toEqual([]);
    expect(diff.commitsIncomplete).toBeUndefined();
  });

  test("a whole review says nothing at all, so the ordinary surface stays quiet", async () => {
    const diff = await sessionDiffAsync(toAsync(reviewRunner(REVIEW)), base);
    expect(diff.filesIncomplete).toBeUndefined();
    expect(diff.commitsIncomplete).toBeUndefined();
    expect(diff.baseUnverified).toBeUndefined();
  });

  test("a killed patch is marked, not returned as an empty one that reads as 'binary file'", async () => {
    const killed = await sessionFilePatchAsync(toAsync(reviewRunner({ ...REVIEW, "diff --unified=3": timedOut("diff") })), { ...base, path: "src/a.ts" });
    expect(killed).toEqual({ patch: "", binary: false, incomplete: "timeout" });
    const broken = await sessionFilePatchAsync(toAsync(reviewRunner({ ...REVIEW, "diff --unified=3": { status: 128, stdout: "", stderr: "fatal" } })), {
      ...base,
      path: "src/a.ts",
    });
    expect(broken.incomplete).toBe("failed");
    const differs = await sessionFilePatchAsync(toAsync(reviewRunner({ ...REVIEW, "diff --no-index": { status: 1, stdout: "@@ -0,0 +1 @@\n+new\n", stderr: "" } })), {
      ...base,
      path: "dist/app.js",
      untracked: true,
    });
    expect(differs.incomplete).toBeUndefined();
    expect(differs.patch).toContain("+new");
  });

  test("exit 1 is success on the --no-index arm ONLY — issue #694", async () => {
    const reply = { status: 1, stdout: "@@ -1 +1 @@\n-a\n+b\n", stderr: "" };
    const tracked = await sessionFilePatchAsync(toAsync(reviewRunner({ ...REVIEW, "diff --unified=3": reply })), { ...base, path: "src/a.ts" });
    expect(tracked.incomplete).toBe("failed");
    expect(tracked.patch).toBe("");

    const untracked = await sessionFilePatchAsync(toAsync(reviewRunner({ ...REVIEW, "diff --no-index": reply })), { ...base, path: "dist/app.js", untracked: true });
    expect(untracked.incomplete).toBeUndefined();
    expect(untracked.patch).toBe(reply.stdout);
  });

  test("a child killed at the output bound is truncated, not a timeout and not a success — issue #694", async () => {
    const overflowed = { status: 1, stdout: "@@ -1,9 +1,9 @@\n-a\n+b\n-cut mid-li", stderr: "wrote more than", overflowed: true } as const;
    const tracked = await sessionFilePatchAsync(toAsync(reviewRunner({ ...REVIEW, "diff --unified=3": overflowed })), { ...base, path: "src/a.ts" });
    expect(tracked.incomplete).toBe("truncated");
    expect(tracked.patch).toBe(overflowed.stdout);
    expect(tracked.binary).toBe(false);

    const untracked = await sessionFilePatchAsync(toAsync(reviewRunner({ ...REVIEW, "diff --no-index": overflowed })), {
      ...base,
      path: "dist/app.js",
      untracked: true,
    });
    expect(untracked.incomplete).toBe("truncated");
    expect(untracked.patch).toBe(overflowed.stdout);
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
      expect(await sessionDiffAsync(async, base)).toEqual(await sessionDiffAsync(toAsync(sync), base));
    }

    const patchSync = reviewRunner({ ...REVIEW, "diff --unified=3": timedOut("diff") });
    const patchAsync: AsyncGitRunner = async (cwd, args) => patchSync(cwd, args);
    expect(await sessionFilePatchAsync(patchAsync, { ...base, path: "src/a.ts" })).toEqual(
      await sessionFilePatchAsync(toAsync(patchSync), { ...base, path: "src/a.ts" }),
    );
  });
});

describe("sessionFilePatch, ignoring whitespace", () => {
  function recording(): { runner: GitRunner; calls: string[][] } {
    const calls: string[][] = [];
    const runner: GitRunner = (_cwd, args) => {
      calls.push(subcommand(args));
      if (subcommand(args)[0] === "rev-parse") return ok("");
      return ok("@@ -1 +1 @@\n-a\n+b\n");
    };
    return { runner, calls };
  }

  test("off by default — the ordinary read is unchanged", async () => {
    const { runner, calls } = recording();
    await sessionFilePatchAsync(toAsync(runner), { cwd: "/repo", path: "src/a.ts" });
    expect(calls.at(-1)).toEqual(["diff", "--unified=3", "HEAD", "--", ":(literal)src/a.ts"]);
  });

  test("on, the command carries -w AND --ignore-blank-lines", async () => {
    const { runner, calls } = recording();
    await sessionFilePatchAsync(toAsync(runner), { cwd: "/repo", path: "src/a.ts", ignoreWhitespace: true });
    expect(calls.at(-1)).toEqual(["diff", "--unified=3", "-w", "--ignore-blank-lines", "HEAD", "--", ":(literal)src/a.ts"]);
  });

  test("an untracked file ignores whitespace too, against /dev/null", async () => {
    const { runner, calls } = recording();
    await sessionFilePatchAsync(toAsync(runner), { cwd: "/repo", path: "dist/app.js", untracked: true, ignoreWhitespace: true });
    expect(calls.at(-1)).toEqual(["diff", "--no-index", "--unified=3", "-w", "--ignore-blank-lines", "--", "/dev/null", "dist/app.js"]);
  });

  test("both arms read paths raw, so a non-ASCII name is a name — issue #694", async () => {
    const raw: string[][] = [];
    const watching: GitRunner = (_cwd, args) => {
      raw.push(args);
      return subcommand(args)[0] === "rev-parse" ? ok("") : ok("@@ -1 +1 @@\n-a\n+b\n");
    };
    await sessionFilePatchAsync(toAsync(watching), { cwd: "/repo", path: "café.ts" });
    await sessionFilePatchAsync(toAsync(watching), { cwd: "/repo", path: "café.ts", untracked: true });
    const patches = raw.filter((args) => subcommand(args)[0] === "diff");
    expect(patches).toHaveLength(2);
    for (const args of patches) expect(args.slice(0, 2)).toEqual(["-c", "core.quotePath=false"]);
  });

  test("the flag goes AFTER --unified=3 and BEFORE the base, so the base is still a base", async () => {
    const { runner, calls } = recording();
    await sessionFilePatchAsync(toAsync(runner), { cwd: "/repo", baseRef: "abc1234", path: "src/a.ts", ignoreWhitespace: true });
    const args = calls.at(-1)!;
    expect(args.indexOf("-w")).toBeLessThan(args.indexOf("abc1234"));
    expect(args.indexOf("abc1234")).toBeLessThan(args.indexOf("--"));
  });
});

describe("commitSessionWork", () => {
  test("stages everything, then commits, and reports the new commit", async () => {
    const calls: string[][] = [];
    const git: GitRunner = (_cwd, args) => {
      calls.push(args);
      const key = args.slice(0, 2).join(" ");
      if (key === "rev-parse --is-inside-work-tree") return ok("true\n");
      if (key === "add -A") return ok("");
      if (key === "diff --cached") return fail();
      if (key === "commit -m") return ok("");
      if (key === "log -1") return ok(["sha1", "sha1sho", "Session work", "1700000000", "Ada"].join("\x1f") + "\x1e");
      return fail();
    };
    const result = await commitSessionWork(async (cwd, args) => git(cwd, args), { cwd: "/repo", message: "Session work" });
    expect(result.committed).toBe(true);
    expect(result.commit?.shortSha).toBe("sha1sho");
    expect(calls.some((args) => args[0] === "add" && args[1] === "-A")).toBe(true);
  });

  test("a clean tree is an answer, not a failure", async () => {
    const git: GitRunner = (_cwd, args) => {
      const key = args.slice(0, 2).join(" ");
      if (key === "rev-parse --is-inside-work-tree") return ok("true\n");
      if (key === "add -A") return ok("");
      if (key === "diff --cached") return ok("");
      return fail();
    };
    expect(await commitSessionWork(async (cwd, args) => git(cwd, args), { cwd: "/repo", message: "x" })).toMatchObject({ committed: false });
  });

  test("a hook that refuses is passed through in its own words", async () => {
    const git: GitRunner = (_cwd, args) => {
      const key = args.slice(0, 2).join(" ");
      if (key === "rev-parse --is-inside-work-tree") return ok("true\n");
      if (key === "add -A") return ok("");
      if (key === "diff --cached") return fail();
      if (key === "commit -m") return { status: 1, stdout: "", stderr: "pre-commit: lint failed on 3 files\n" };
      return fail();
    };
    expect((await commitSessionWork(async (cwd, args) => git(cwd, args), { cwd: "/repo", message: "x" })).reason).toBe("pre-commit: lint failed on 3 files");
  });
});

describe("normalizeRemote", () => {
  test("every spelling of one repository is one string", () => {
    const spellings = [
      "git@github.com:NovarixHQ/telar.git",
      "git@github.com:NovarixHQ/telar",
      "https://github.com/NovarixHQ/telar.git",
      "https://github.com/NovarixHQ/telar",
      "https://github.com/NovarixHQ/telar/",
      "ssh://git@github.com:22/NovarixHQ/telar.git",
      "ssh://git@github.com/NovarixHQ/telar.git",
      "git://github.com/NovarixHQ/telar.git",
      "  https://github.com/novarixhq/telar.git\n",
    ];
    for (const spelling of spellings) {
      expect([spelling, normalizeRemote(spelling)]).toEqual([spelling, "github.com/novarixhq/telar"]);
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
