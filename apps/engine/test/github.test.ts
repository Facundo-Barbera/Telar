/**
 * The `gh` seam.
 *
 * Every one of these is about a FAILURE MODE rather than about the happy path,
 * because the happy path is `JSON.parse` and the failures are where a surface
 * either tells a reader what to do or wastes their afternoon.
 */
import { describe, expect, test } from "bun:test";
import { classifyGhFailure, parseIssues, parsePulls, readGitHub, type GhResult, type GhRunner } from "../src/github";

const ok = (stdout: string): GhResult => ({ status: 0, stdout, stderr: "" });
const failed = (stderr: string, status = 1): GhResult => ({ status, stdout: "", stderr });

/** Keyed by the first argv word, which is all these three calls differ by. */
function runner(replies: Record<string, GhResult>): GhRunner {
  return async (_cwd, args) => replies[args[0] ?? ""] ?? failed("unexpected call");
}

describe("classifyGhFailure", () => {
  test("tells the four kinds of nothing apart", () => {
    // They need four different responses from a human, and the third is usually
    // "nothing, that is fine". One grey empty list would earn none of them.
    expect(classifyGhFailure(failed("", 127)).unavailable).toBe("not_installed");
    expect(classifyGhFailure(failed("gh: To get started with GitHub CLI, please run: gh auth login")).unavailable).toBe("not_authenticated");
    expect(classifyGhFailure(failed("failed to run git: fatal: not a git repository")).unavailable).toBe("no_repository");
  });

  test("an unrecognised failure keeps gh's own words rather than guessing", () => {
    // The match is on phrasing and phrasing changes upstream; degrading to
    // "here is what gh said" beats degrading to a wrong diagnosis.
    const result = classifyGhFailure(failed("HTTP 403: API rate limit exceeded"));
    expect(result.unavailable).toBe("failed");
    expect(result.message).toBe("HTTP 403: API rate limit exceeded");
  });
});

describe("parseIssues", () => {
  test("flattens gh's nested author and converts its ISO time to epoch milliseconds", () => {
    // Converted once at the seam rather than by every client that renders a date.
    const [issue] = parseIssues(
      JSON.stringify([
        {
          number: 82,
          title: "Navigation freezes",
          state: "OPEN",
          author: { login: "ada", name: "Ada L" },
          labels: [{ name: "bug", color: "d73a4a" }, { name: "" }],
          updatedAt: "2026-08-08T18:54:57Z",
          url: "https://github.com/o/r/issues/82",
        },
      ]),
    );
    expect(issue).toEqual({
      number: 82,
      title: "Navigation freezes",
      state: "OPEN",
      author: "ada",
      // A label with no name is dropped rather than rendered as an empty chip.
      labels: [{ name: "bug", color: "d73a4a" }],
      updatedAt: Date.parse("2026-08-08T18:54:57Z"),
      url: "https://github.com/o/r/issues/82",
    });
  });

  test("a row without a number is not a row", () => {
    expect(parseIssues(JSON.stringify([{ title: "orphan" }]))).toEqual([]);
  });
});

describe("parsePulls", () => {
  test("keeps the head branch and GitHub's own review vocabulary", () => {
    // `headRefName` is what lets a session recognise its own pull request;
    // `reviewDecision` is passed through because mapping it is a display
    // decision three clients should not each invent.
    const [pull] = parsePulls(
      JSON.stringify([
        {
          number: 45,
          title: "Fix the rail",
          state: "OPEN",
          isDraft: true,
          headRefName: "telar/session-1",
          reviewDecision: "CHANGES_REQUESTED",
          updatedAt: "2026-08-08T00:00:00Z",
          url: "u",
        },
      ]),
    );
    expect(pull).toMatchObject({ isDraft: true, headRefName: "telar/session-1", reviewDecision: "CHANGES_REQUESTED" });
  });
});

describe("readGitHub", () => {
  test("reads issues, pulls and the repository name in one pass", async () => {
    const snapshot = await readGitHub(
      runner({
        issue: ok(JSON.stringify([{ number: 1, title: "a", state: "OPEN", labels: [], updatedAt: "2026-01-01T00:00:00Z", url: "u" }])),
        pr: ok(JSON.stringify([{ number: 2, title: "b", state: "OPEN", updatedAt: "2026-01-01T00:00:00Z", url: "u" }])),
        repo: ok(JSON.stringify({ nameWithOwner: "o/r" })),
      }),
      "/repo",
      () => 1_000,
    );
    expect(snapshot).toMatchObject({ repository: "o/r", readAt: 1_000 });
    expect(snapshot.issues).toHaveLength(1);
    expect(snapshot.pulls).toHaveLength(1);
    expect(snapshot.unavailable).toBeUndefined();
  });

  test("a repository with issues disabled still reports its pull requests", async () => {
    // They fail independently; reporting the whole repository as unavailable
    // because one endpoint is off would hide work that is right there.
    const snapshot = await readGitHub(
      runner({
        issue: failed("the 'o/r' repository has disabled issues"),
        pr: ok(JSON.stringify([{ number: 2, title: "b", state: "OPEN", updatedAt: "2026-01-01T00:00:00Z", url: "u" }])),
        repo: ok(JSON.stringify({ nameWithOwner: "o/r" })),
      }),
      "/repo",
      () => 1_000,
    );
    expect(snapshot.pulls).toHaveLength(1);
    expect(snapshot.unavailable).toBe("failed");
  });

  test("output this engine cannot read is reported as a failure, not as an empty list", async () => {
    // A version skew must not look like a repository with no issues.
    const snapshot = await readGitHub(runner({ issue: ok("<html>"), pr: ok("[]"), repo: failed("") }), "/repo", () => 0);
    expect(snapshot.unavailable).toBe("failed");
    expect(snapshot.repository).toBeUndefined();
  });
});
