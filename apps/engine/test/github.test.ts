/**
 * The `gh` seam.
 *
 * Every one of these is about a FAILURE MODE rather than about the happy path,
 * because the happy path is `JSON.parse` and the failures are where a surface
 * either tells a reader what to do or wastes their afternoon.
 */
import { describe, expect, test } from "bun:test";
import {
  classifyDetailFailure,
  classifyGhFailure,
  classifyMergeFailure,
  MAX_THREAD_COMMENTS,
  mergePull,
  parseChecks,
  parseComments,
  parseIssueDetail,
  parseIssues,
  parseMergeMethods,
  parsePullDetail,
  parsePulls,
  parseReviews,
  readGitHub,
  readIssue,
  readPull,
  type GhResult,
  type GhRunner,
} from "../src/github";

const ok = (stdout: string): GhResult => ({ status: 0, stdout, stderr: "" });
const failed = (stderr: string, status = 1): GhResult => ({ status, stdout: "", stderr });

/** Keyed by the first argv word, which is all these three calls differ by. */
function runner(replies: Record<string, GhResult>): GhRunner {
  return async (_cwd, args) => replies[args[0] ?? ""] ?? failed("unexpected call");
}

/** Keyed by the first TWO words, so `pr view` and `pr merge` can answer
 *  differently — which is the whole shape of a merge. */
function verbRunner(replies: Record<string, GhResult | GhResult[]>, seen?: string[][]): GhRunner {
  const drawn = new Map<string, number>();
  return async (_cwd, args) => {
    seen?.push(args);
    const key = args.slice(0, 2).join(" ");
    const reply = replies[key];
    if (!reply) return failed(`unexpected call: ${key}`);
    if (!Array.isArray(reply)) return reply;
    // An array answers successive calls in order — a merge reads the pull request
    // BEFORE and AFTER, and the two are different.
    const at = drawn.get(key) ?? 0;
    drawn.set(key, at + 1);
    return reply[Math.min(at, reply.length - 1)]!;
  };
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

// ── one issue, one pull request ─────────────────────────────────────────────

const iso = (day: number) => `2026-08-${String(day).padStart(2, "0")}T00:00:00Z`;

describe("parseComments", () => {
  test("orders by creation, so a capped thread keeps the NEWEST comments", () => {
    // The cap keeps a tail, and a tail is only the newest if the list is sorted.
    // It has always arrived sorted; relying on that would make the cap correct
    // only until it was not.
    const thread = parseComments([
      { url: "c3", body: "third", createdAt: iso(3) },
      { url: "c1", body: "first", createdAt: iso(1) },
      { url: "c2", body: "second", createdAt: iso(2) },
    ]);
    expect(thread.comments.map((entry) => entry.body)).toEqual(["first", "second", "third"]);
    expect(thread.olderComments).toBe(0);
  });

  test("a long thread is cut from the FRONT and says how many it dropped", () => {
    // Rendering three thousand markdown blocks into a 320px column locks the
    // window. The opening context is the issue BODY, which is carried whole, so
    // the newest comments are the ones worth the budget.
    const many = Array.from({ length: MAX_THREAD_COMMENTS + 5 }, (_unused, index) => ({
      url: `c${index}`,
      body: `#${index}`,
      createdAt: new Date(index * 1_000).toISOString(),
    }));
    const thread = parseComments(many);
    expect(thread.comments).toHaveLength(MAX_THREAD_COMMENTS);
    expect(thread.olderComments).toBe(5);
    // The last one is present and the first five are not — the cut is at the old end.
    expect(thread.comments.at(-1)!.body).toBe(`#${MAX_THREAD_COMMENTS + 4}`);
    expect(thread.comments[0]!.body).toBe("#5");
  });

  test("a comment GitHub hid stays hidden, with its reason", () => {
    // Rendering a spam-hidden comment in full beside the real ones shows a reader
    // something the repository decided to hide.
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
    // Every review, not the latest per reviewer: hiding the round that requested
    // changes because a later one approved loses why it was approved.
    const reviews = parseReviews([
      { author: { login: "b" }, state: "APPROVED", body: "lgtm", submittedAt: iso(2) },
      { author: { login: "a" }, state: "CHANGES_REQUESTED", body: "no", submittedAt: iso(1) },
    ]);
    expect(reviews).toEqual([
      { author: "a", state: "CHANGES_REQUESTED", body: "no", submittedAt: Date.parse(iso(1)) },
      { author: "b", state: "APPROVED", body: "lgtm", submittedAt: Date.parse(iso(2)) },
    ]);
  });

  test("a review with no state is not a review", () => {
    // It is neither an approval, a rejection nor a comment.
    expect(parseReviews([{ author: { login: "a" }, body: "?", submittedAt: iso(1) }])).toEqual([]);
  });
});

describe("parseChecks", () => {
  test("a check run keeps its own status, conclusion and workflow", () => {
    // Measured against a real pull request — these are the field names gh emits.
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
    // The older API has `context`/`state`/`targetUrl` and no status of its own. A
    // client that had to know which of the two it was holding would grow a
    // `__typename` switch in every renderer.
    expect(
      parseChecks([
        { __typename: "StatusContext", context: "ci/build", state: "SUCCESS", targetUrl: "https://ci/1" },
        { __typename: "StatusContext", context: "ci/slow", state: "PENDING", targetUrl: "" },
        // ERROR becomes FAILURE: a check run has no ERROR conclusion, and every
        // reader would otherwise have to learn that a sixth word also means red.
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
    // GitHub adding a third rollup type must degrade to one missing check.
    expect(parseChecks([{ __typename: "SomethingNew", mystery: true }, { name: "lint", status: "COMPLETED" }])).toEqual([
      { name: "lint", status: "COMPLETED" },
    ]);
  });
});

describe("parseIssueDetail", () => {
  test("adds the body and the conversation to the same row the list parses", () => {
    // Both readers share `issueRow`, so a title cannot change when you click it.
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
    // `epoch` answers 0 for an absent date, and 0 renders as January 1970.
    const issue = parseIssueDetail(JSON.stringify({ number: 1, title: "t", state: "OPEN", url: "u", createdAt: iso(1) }), 1);
    expect(issue.closedAt).toBeUndefined();
    expect(issue.assignees).toEqual([]);
    expect(issue.milestone).toBeUndefined();
  });
});

describe("parsePullDetail", () => {
  test("carries both merge questions, the branch pair and the head commit", () => {
    // `mergeable` and `mergeStateStatus` are different questions: do the trees
    // combine, and will GitHub let you. A pull request can be both mergeable and
    // blocked.
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
    // GitHub computes it lazily, so the first read of a quiet pull request
    // routinely has neither field — measured. `UNKNOWN` is its own word for "ask
    // again", and every client already handles it; an empty string is a fifth
    // state nobody has a branch for.
    const pull = parsePullDetail(JSON.stringify({ number: 1, title: "t", state: "OPEN", url: "u", createdAt: iso(1) }), 1);
    expect(pull.mergeable).toBe("UNKNOWN");
    expect(pull.mergeStateStatus).toBe("UNKNOWN");
    expect(pull.additions).toBe(0);
    expect(pull.mergedAt).toBeUndefined();
  });
});

describe("parseMergeMethods", () => {
  test("offers only what the repository allows", () => {
    // Measured on this repository, which allows merge commits and nothing else —
    // exactly the case where a squash button would refuse for a reason nobody
    // could have predicted from the screen.
    expect(parseMergeMethods(JSON.stringify({ mergeCommitAllowed: true, squashMergeAllowed: false, rebaseMergeAllowed: false }))).toEqual(["merge"]);
    expect(parseMergeMethods(JSON.stringify({ mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: true }))).toEqual([
      "merge",
      "squash",
      "rebase",
    ]);
  });

  test("a read that failed offers ALL THREE, not none", () => {
    // Guessing generously costs one refusal that names itself; guessing meanly
    // costs a button that cannot be pressed for a reason nobody can see.
    expect(parseMergeMethods("")).toEqual(["merge", "squash", "rebase"]);
    expect(parseMergeMethods("<html>")).toEqual(["merge", "squash", "rebase"]);
  });

  test("a repository that allows none of them is honoured, not widened", () => {
    // `gh` saying "all off" is a different fact from `gh` not answering.
    expect(parseMergeMethods(JSON.stringify({ mergeCommitAllowed: false, squashMergeAllowed: false, rebaseMergeAllowed: false }))).toEqual([]);
  });
});

describe("classifyDetailFailure", () => {
  test("a number nobody used is not a broken machine", () => {
    // gh: "GraphQL: Could not resolve to a PullRequest with the number of 999999"
    // — measured. Reporting that as `failed` would send a reader to check their
    // gh install over a typo.
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

// ── merging ────────────────────────────────────────────────────────────────

/** An open, mergeable pull request at `head`. */
const mergeable = (over: Record<string, unknown> = {}) =>
  ok(
    JSON.stringify({
      number: 12,
      title: "Ship it",
      state: "OPEN",
      isDraft: false,
      url: "u",
      createdAt: iso(1),
      baseRefName: "main",
      headRefName: "telar/x",
      headRefOid: "head-1",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      ...over,
    }),
  );

describe("mergePull", () => {
  test("sends the method and PINS THE HEAD the reader reviewed", async () => {
    const seen: string[][] = [];
    const result = await mergePull(
      verbRunner({ "pr view": mergeable(), "pr merge": ok("") }, seen),
      "/repo",
      { number: 12, method: "squash", expectedHeadOid: "head-1" },
      () => 100,
    );
    expect(result.merged).toBe(true);
    // The argv, verbatim. `--match-head-commit` is the precondition: without it a
    // person reviews one diff, an agent pushes another commit, and the button
    // merges code nobody looked at.
    expect(seen.find((args) => args[1] === "merge")).toEqual(["pr", "merge", "12", "--squash", "--match-head-commit", "head-1"]);
    // And no --admin, no --auto, no --delete-branch: bypassing the repository's
    // own protection, merging later without the person, and deleting a branch a
    // session's worktree may be sitting on.
    const merge = seen.find((args) => args[1] === "merge")!;
    expect(merge.some((arg) => ["--admin", "--auto", "--delete-branch"].includes(arg))).toBe(false);
  });

  test("REPORTS THE PULL REQUEST AS IT IS AFTER THE MERGE, re-read", async () => {
    // Reporting the pre-merge record with a success flag is exactly the stale-
    // header bug the file editor had.
    const result = await mergePull(
      verbRunner({
        "pr view": [mergeable(), mergeable({ state: "MERGED", mergedAt: iso(4), mergedBy: { login: "ada" } })],
        "pr merge": ok(""),
      }),
      "/repo",
      { number: 12, method: "merge", expectedHeadOid: "head-1" },
      () => 100,
    );
    expect(result).toMatchObject({ merged: true, pull: { state: "MERGED", mergedBy: "ada" } });
  });

  test("a merge that WORKED and a confirming read that did not is still a merge", async () => {
    // Reporting a refusal here would be a lie about a merged pull request.
    const result = await mergePull(
      verbRunner({ "pr view": [mergeable(), failed("HTTP 502")], "pr merge": ok("") }, undefined),
      "/repo",
      { number: 12, method: "merge", expectedHeadOid: "head-1" },
      () => 4_242,
    );
    expect(result).toMatchObject({ merged: true, pull: { state: "MERGED", mergedAt: 4_242 } });
  });

  describe("refuses from the pull request's own fields, without asking GitHub", () => {
    /** Every case here must NOT reach `pr merge` — the runner has no reply for
     *  it, so a call would fail the assertion on `merged`. */
    const refuse = (view: GhResult, expected = "head-1") =>
      mergePull(verbRunner({ "pr view": view }), "/repo", { number: 12, method: "squash", expectedHeadOid: expected }, () => 1);

    test("a head that moved since the read", async () => {
      // The case the precondition exists for, caught before GitHub is asked.
      expect(await refuse(mergeable({ headRefOid: "head-2" }))).toMatchObject({
        merged: false,
        refusal: "head_moved",
        message: "A commit landed on telar/x after this page was read.",
      });
    });

    test("a pull request that is already merged", async () => {
      expect(await refuse(mergeable({ state: "MERGED", mergedAt: iso(2) }))).toMatchObject({
        merged: false,
        refusal: "not_open",
        message: "#12 was already merged.",
      });
    });

    test("a draft", async () => {
      expect(await refuse(mergeable({ isDraft: true }))).toMatchObject({ merged: false, refusal: "blocked" });
    });

    test("conflicting trees", async () => {
      expect(await refuse(mergeable({ mergeable: "CONFLICTING" }))).toMatchObject({
        merged: false,
        refusal: "conflicted",
        message: "#12 conflicts with main.",
      });
    });

    test("a merge GitHub says is blocked, from the FIELD rather than from gh's prose", async () => {
      // Measured: `gh` describes this same situation as "is not mergeable: the base
      // branch policy prohibits the merge", which reads like a conflict. One field
      // beats one sentence.
      expect(await refuse(mergeable({ mergeStateStatus: "BLOCKED" }))).toMatchObject({ merged: false, refusal: "blocked" });
    });

    test("mergeability GitHub has not computed yet is NOT a refusal", async () => {
      // `UNKNOWN` means ask again, not no. Refusing here would block every first
      // merge of a quiet pull request.
      const result = await mergePull(
        verbRunner({ "pr view": mergeable({ mergeable: "UNKNOWN" }), "pr merge": ok("") }),
        "/repo",
        { number: 12, method: "squash", expectedHeadOid: "head-1" },
        () => 1,
      );
      expect(result.merged).toBe(true);
    });

    test("a number nobody used", async () => {
      expect(await refuse(failed("GraphQL: Could not resolve to a PullRequest with the number of 12"))).toMatchObject({
        merged: false,
        refusal: "not_open",
      });
    });

    test("a read that failed for any other reason does not become a merge", async () => {
      // Nothing is known about the pull request, including whether merging it
      // would be safe.
      expect(await refuse(failed("HTTP 502"))).toMatchObject({ merged: false, refusal: "failed", message: "HTTP 502" });
    });
  });
});

describe("classifyMergeFailure", () => {
  test("BRANCH PROTECTION WEARING THE WORDS FOR A CONFLICT is not a conflict", () => {
    /**
     * gh's real message, measured against cli/cli#14120:
     *
     *   X Pull request cli/cli#14120 is not mergeable: the base branch policy
     *     prohibits the merge.
     *
     * The first version of this classifier matched "not mergeable" before
     * "branch policy" and told the reader to rebase a branch with nothing wrong
     * with it. Only driving the real thing found it, which is why the whole
     * sentence is pinned here rather than a phrase from it.
     */
    const real = failed(
      "X Pull request cli/cli#14120 is not mergeable: the base branch policy prohibits the merge.\nTo have the pull request merged after all the requirements have been met, add the `--auto` flag.",
    );
    expect(classifyMergeFailure(real).refusal).toBe("blocked");
  });

  test("names the refusals the engine could not decide from data", () => {
    expect(classifyMergeFailure(failed("Head branch was modified. Review and try the merge again.")).refusal).toBe("head_moved");
    expect(classifyMergeFailure(failed("Pull request is not mergeable: the merge commit cannot be cleanly created")).refusal).toBe("conflicted");
    expect(classifyMergeFailure(failed("Squash merges are not allowed on this repository")).refusal).toBe("method_not_allowed");
    expect(classifyMergeFailure(failed("Must have admin rights to Repository.")).refusal).toBe("not_permitted");
    expect(classifyMergeFailure(failed("At least 1 approving review is required by reviewers")).refusal).toBe("blocked");
    expect(classifyMergeFailure(failed("Pull request #12 was already merged")).refusal).toBe("not_open");
  });

  test("an unrecognised refusal keeps gh's own words rather than guessing", () => {
    // The same trade as `classifyGhFailure`: phrasing changes upstream, and
    // "here is what gh said" beats a confident wrong diagnosis. Every sentence
    // above is a phrase match, so this fallback is the one that has to be safe.
    expect(classifyMergeFailure(failed("something entirely new"))).toEqual({ refusal: "failed", message: "something entirely new" });
  });
});
