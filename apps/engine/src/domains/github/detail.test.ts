import { describe, expect, test } from "bun:test";
import { classifyDetailFailure, MAX_CHECK_LOG_LINES, parseCheckLog, parseChecks, parseIssueDetail, parseJobId, parseMergeMethods, parsePullDetail, readCheckLog, readIssue, readPull } from "./detail";
import { MAX_THREAD_COMMENTS, parseComments, parseReviews } from "./threads";
import { failed, iso, ok, runner } from "./test-helpers";


describe("parseComments", () => {
  test("orders by creation, so a capped thread keeps the NEWEST comments", () => {
    const thread = parseComments([
      { url: "c3", body: "third", createdAt: iso(3) },
      { url: "c1", body: "first", createdAt: iso(1) },
      { url: "c2", body: "second", createdAt: iso(2) },
    ]);
    expect(thread.comments.map((entry) => entry.body)).toEqual(["first", "second", "third"]);
    expect(thread.olderComments).toBe(0);
  });

  test("a long thread is cut from the FRONT and says how many it dropped", () => {
    const many = Array.from({ length: MAX_THREAD_COMMENTS + 5 }, (_unused, index) => ({
      url: `c${index}`,
      body: `#${index}`,
      createdAt: new Date(index * 1_000).toISOString(),
    }));
    const thread = parseComments(many);
    expect(thread.comments).toHaveLength(MAX_THREAD_COMMENTS);
    expect(thread.olderComments).toBe(5);
    expect(thread.comments.at(-1)!.body).toBe(`#${MAX_THREAD_COMMENTS + 4}`);
    expect(thread.comments[0]!.body).toBe("#5");
  });

  test("a comment GitHub hid stays hidden, with its reason", () => {
    const [comment] = parseComments([
      { url: "c1", body: "buy followers", createdAt: iso(1), isMinimized: true, minimizedReason: "SPAM", authorAssociation: "NONE" },
    ]).comments;
    expect(comment).toMatchObject({ minimized: true, minimizedReason: "SPAM", authorAssociation: "NONE" });
  });

  test("a comment with no url is dropped rather than rendered as a dead row", () => {
    expect(parseComments([{ body: "orphan", createdAt: iso(1) }]).comments).toEqual([]);
  });
});

describe("parseReviews", () => {
  test("keeps every round in order and flattens the author", () => {
    const reviews = parseReviews([
      { author: { login: "b" }, state: "APPROVED", body: "lgtm", submittedAt: iso(2) },
      { author: { login: "a" }, state: "CHANGES_REQUESTED", body: "no", submittedAt: iso(1) },
    ]);
    expect(reviews).toEqual([
      { author: "a", authorAvatar: "https://github.com/a.png", state: "CHANGES_REQUESTED", body: "no", submittedAt: Date.parse(iso(1)) },
      { author: "b", authorAvatar: "https://github.com/b.png", state: "APPROVED", body: "lgtm", submittedAt: Date.parse(iso(2)) },
    ]);
  });

  test("a review with no state is not a review", () => {
    expect(parseReviews([{ author: { login: "a" }, body: "?", submittedAt: iso(1) }])).toEqual([]);
  });
});

describe("parseChecks", () => {
  test("a check run keeps its own status, conclusion and workflow", () => {
    expect(
      parseChecks([
        {
          __typename: "CheckRun",
          name: "lint",
          status: "COMPLETED",
          conclusion: "SUCCESS",
          detailsUrl: "https://gh/job/1",
          workflowName: "Lint",
        },
      ]),
    ).toEqual([{ name: "lint", status: "COMPLETED", conclusion: "SUCCESS", workflow: "Lint", url: "https://gh/job/1" }]);
  });

  test("a running check has NO conclusion, which is not the same as passing", () => {
    const [check] = parseChecks([{ __typename: "CheckRun", name: "test", status: "IN_PROGRESS", conclusion: "" }]);
    expect(check).toEqual({ name: "test", status: "IN_PROGRESS" });
    expect(check!.conclusion).toBeUndefined();
  });

  test("a commit status is flattened into the same shape", () => {
    expect(
      parseChecks([
        { __typename: "StatusContext", context: "ci/build", state: "SUCCESS", targetUrl: "https://ci/1" },
        { __typename: "StatusContext", context: "ci/slow", state: "PENDING", targetUrl: "" },
        { __typename: "StatusContext", context: "ci/broken", state: "ERROR", targetUrl: "https://ci/3" },
        { __typename: "StatusContext", context: "ci/queued", state: "EXPECTED" },
      ]),
    ).toEqual([
      { name: "ci/build", status: "COMPLETED", conclusion: "SUCCESS", url: "https://ci/1" },
      { name: "ci/slow", status: "IN_PROGRESS" },
      { name: "ci/broken", status: "COMPLETED", conclusion: "FAILURE", url: "https://ci/3" },
      { name: "ci/queued", status: "QUEUED" },
    ]);
  });

  test("an entry this parser cannot name costs a row, not the panel", () => {
    expect(parseChecks([{ __typename: "SomethingNew", mystery: true }, { name: "lint", status: "COMPLETED" }])).toEqual([
      { name: "lint", status: "COMPLETED" },
    ]);
  });
});

describe("parseJobId", () => {
  test("the Actions job is inside the check's details URL, and nowhere else", () => {
    expect(parseJobId("https://github.com/cli/cli/actions/runs/18386406777/job/52385857117")).toBe("52385857117");
  });

  test("a URL that is not an Actions job has none, which is a normal answer", () => {
    expect(parseJobId("https://circleci.com/gh/o/r/1234")).toBeUndefined();
    expect(parseJobId("https://github.com/o/r/actions/runs/123")).toBeUndefined();
    expect(parseJobId("")).toBeUndefined();
  });
});

describe("parseCheckLog", () => {
  const REAL = [
    "no-response / noResponse\tUNKNOWN STEP\t﻿2026-08-12T16:25:32.4355162Z Current runner version: '2.336.0'",
    "no-response / noResponse\tUNKNOWN STEP\t2026-08-12T16:25:32.4391472Z ##[group]Runner Image Provisioner",
  ].join("\n");

  test("strips the job, the step, the timestamp and the BOM", () => {
    expect(parseCheckLog(REAL).lines).toEqual(["Current runner version: '2.336.0'", "##[group]Runner Image Provisioner"]);
  });

  test("KEEPS THE TAIL, because the failure is at the bottom", () => {
    const many = Array.from({ length: MAX_CHECK_LOG_LINES + 40 }, (_unused, at) => `line ${at}`).join("\n");
    const parsed = parseCheckLog(many);
    expect(parsed.lines).toHaveLength(MAX_CHECK_LOG_LINES);
    expect(parsed.truncated).toBe(true);
    expect(parsed.lines.at(-1)).toBe(`line ${MAX_CHECK_LOG_LINES + 39}`);
    expect(parsed.lines[0]).toBe("line 40");
  });

  test("blank lines are dropped rather than padding the cap", () => {
    expect(parseCheckLog("a\n\n   \nb").lines).toEqual(["a", "b"]);
  });

  test("a line with no prefix at all survives intact", () => {
    expect(parseCheckLog("plain failure text").lines).toEqual(["plain failure text"]);
  });
});

describe("readCheckLog", () => {
  test("a job with no failing STEP says so rather than showing an empty box", async () => {
    const read = await readCheckLog(async () => ok("   \n\n"), "/repo", "42");
    expect(read).toEqual({ unavailable: "This job has no failing step to show a log for." });
  });

  test("gh refusing carries its own words", async () => {
    expect(await readCheckLog(async () => failed("HTTP 404: Not Found"), "/repo", "42")).toEqual({ unavailable: "HTTP 404: Not Found" });
  });

  test("asks for the FAILING steps of one job, not the whole run", async () => {
    const seen: string[][] = [];
    await readCheckLog(
      async (_cwd, args) => {
        seen.push(args);
        return ok("x\ty\t2026-01-01T00:00:00.0Z boom");
      },
      "/repo",
      "42",
    );
    expect(seen[0]).toEqual(["run", "view", "--job", "42", "--log-failed"]);
  });
});

describe("parseIssueDetail", () => {
  test("adds the body and the conversation to the same row the list parses", () => {
    const issue = parseIssueDetail(
      JSON.stringify({
        number: 7,
        title: "Rail freezes",
        state: "CLOSED",
        stateReason: "NOT_PLANNED",
        author: { login: "ada" },
        body: "# steps",
        labels: [{ name: "bug" }],
        assignees: [{ login: "grace" }, { login: "alan" }],
        milestone: { title: "v2", description: "…" },
        comments: [{ url: "c1", body: "seen it", createdAt: iso(2), author: { login: "grace" } }],
        createdAt: iso(1),
        updatedAt: iso(3),
        closedAt: iso(3),
        url: "https://github.com/o/r/issues/7",
      }),
      9_999,
    );
    expect(issue).toMatchObject({
      number: 7,
      title: "Rail freezes",
      state: "CLOSED",
      stateReason: "NOT_PLANNED",
      body: "# steps",
      assignees: ["grace", "alan"],
      milestone: "v2",
      olderComments: 0,
      createdAt: Date.parse(iso(1)),
      closedAt: Date.parse(iso(3)),
      readAt: 9_999,
    });
    expect(issue.comments).toHaveLength(1);
  });

  test("an OPEN issue has no closing time — not a closing time of 1970", () => {
    const issue = parseIssueDetail(JSON.stringify({ number: 1, title: "t", state: "OPEN", url: "u", createdAt: iso(1) }), 1);
    expect(issue.closedAt).toBeUndefined();
    expect(issue.assignees).toEqual([]);
    expect(issue.milestone).toBeUndefined();
  });
});

describe("parsePullDetail", () => {
  test("carries both merge questions, the branch pair and the head commit", () => {
    const pull = parsePullDetail(
      JSON.stringify({
        number: 12,
        title: "Ship it",
        state: "OPEN",
        isDraft: false,
        author: { login: "ada" },
        body: "why",
        labels: [{ name: "feature", color: "abc" }],
        assignees: [],
        baseRefName: "main",
        headRefName: "telar/x",
        headRefOid: "deadbeef",
        reviewDecision: "APPROVED",
        mergeable: "MERGEABLE",
        mergeStateStatus: "BLOCKED",
        additions: 40,
        deletions: 3,
        changedFiles: 2,
        comments: [],
        reviews: [{ author: { login: "grace" }, state: "APPROVED", body: "", submittedAt: iso(2) }],
        statusCheckRollup: [{ name: "lint", status: "COMPLETED", conclusion: "FAILURE" }],
        createdAt: iso(1),
        updatedAt: iso(2),
        url: "u",
      }),
      5,
    );
    expect(pull).toMatchObject({
      baseRefName: "main",
      headRefName: "telar/x",
      headRefOid: "deadbeef",
      mergeable: "MERGEABLE",
      mergeStateStatus: "BLOCKED",
      labels: [{ name: "feature", color: "abc" }],
      additions: 40,
      deletions: 3,
      changedFiles: 2,
      readAt: 5,
    });
    expect(pull.reviews).toHaveLength(1);
    expect(pull.checks).toEqual([{ name: "lint", status: "COMPLETED", conclusion: "FAILURE" }]);
  });

  test("mergeability GitHub has not computed reads UNKNOWN, never blank", () => {
    const pull = parsePullDetail(JSON.stringify({ number: 1, title: "t", state: "OPEN", url: "u", createdAt: iso(1) }), 1);
    expect(pull.mergeable).toBe("UNKNOWN");
    expect(pull.mergeStateStatus).toBe("UNKNOWN");
    expect(pull.additions).toBe(0);
    expect(pull.mergedAt).toBeUndefined();
  });
});

describe("parseMergeMethods", () => {
  test("offers only what the repository allows", () => {
    expect(parseMergeMethods(JSON.stringify({ mergeCommitAllowed: true, squashMergeAllowed: false, rebaseMergeAllowed: false }))).toEqual(["merge"]);
    expect(parseMergeMethods(JSON.stringify({ mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: true }))).toEqual([
      "merge",
      "squash",
      "rebase",
    ]);
  });

  test("a read that failed offers ALL THREE, not none", () => {
    expect(parseMergeMethods("")).toEqual(["merge", "squash", "rebase"]);
    expect(parseMergeMethods("<html>")).toEqual(["merge", "squash", "rebase"]);
  });

  test("a repository that allows none of them is honoured, not widened", () => {
    expect(parseMergeMethods(JSON.stringify({ mergeCommitAllowed: false, squashMergeAllowed: false, rebaseMergeAllowed: false }))).toEqual([]);
  });
});

describe("classifyDetailFailure", () => {
  test("a number nobody used is not a broken machine", () => {
    expect(classifyDetailFailure(failed("GraphQL: Could not resolve to a PullRequest with the number of 999999")).unavailable).toBe("not_found");
  });

  test("the list's four kinds of nothing still classify the same way", () => {
    expect(classifyDetailFailure(failed("", 127)).unavailable).toBe("not_installed");
    expect(classifyDetailFailure(failed("gh auth login")).unavailable).toBe("not_authenticated");
    expect(classifyDetailFailure(failed("HTTP 502")).unavailable).toBe("failed");
  });
});

describe("readIssue and readPull", () => {
  test("a failure is a typed answer with a sentence, not a throw", async () => {
    const read = await readIssue(runner({ issue: failed("gh: not logged in") }), "/repo", 4);
    expect(read).toEqual({ unavailable: "not_authenticated" });
  });

  test("output this engine cannot read is `failed`, not a crash", async () => {
    expect(await readPull(runner({ pr: ok("<html>") }), "/repo", 4)).toEqual({
      unavailable: "failed",
      message: "gh returned output this engine could not read",
    });
  });

  test("the happy path carries the read time", async () => {
    const read = await readIssue(
      runner({ issue: ok(JSON.stringify({ number: 4, title: "t", state: "OPEN", url: "u", createdAt: iso(1) })) }),
      "/repo",
      4,
      () => 777,
    );
    expect(read).toMatchObject({ issue: { number: 4, readAt: 777 } });
  });
});
