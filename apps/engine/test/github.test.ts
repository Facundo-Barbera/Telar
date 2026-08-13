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
  classifyProjectFailure,
  MAX_THREAD_COMMENTS,
  mergePull,
  parseChecks,
  parseComments,
  parseIssueDetail,
  parseIssues,
  parseMergeMethods,
  parseProjectItems,
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
  test("a row carries everything a list can show without a second read", () => {
    // The whole shape, pinned. Dates converted once at the seam rather than by
    // every client that renders one; assignees flattened to logins because a bot
    // has a login and no name; the milestone reduced to its title, which is the
    // only part a 320px row has space for.
    const [issue] = parseIssues(
      JSON.stringify([
        {
          number: 82,
          title: "Navigation freezes",
          state: "OPEN",
          author: { login: "ada", name: "Ada L" },
          labels: [{ name: "bug", color: "d73a4a" }, { name: "" }],
          assignees: [{ login: "grace" }, { login: "" }],
          milestone: { title: "v2", description: "…" },
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
      // A label with no name is dropped rather than rendered as an empty chip, and
      // so is an assignee with no login.
      labels: [{ name: "bug", color: "d73a4a" }],
      assignees: ["grace"],
      milestone: "v2",
      // EMPTY UNTIL THE BOARD CALL FILLS IT IN. `projectItems` needs a scope this
      // query does not have, so it is read separately — see the board tests below.
      projects: [],
      updatedAt: Date.parse("2026-08-08T18:54:57Z"),
      url: "https://github.com/o/r/issues/82",
    });
  });

  test("a closed row says WHY it closed", () => {
    // On the row and not just the detail: a list that includes closed issues is a
    // list where "was this done?" is the question every row raises.
    const [issue] = parseIssues(
      JSON.stringify([{ number: 1, title: "t", state: "CLOSED", stateReason: "NOT_PLANNED", url: "u", updatedAt: "2026-01-01T00:00:00Z" }]),
    );
    expect(issue).toMatchObject({ state: "CLOSED", stateReason: "NOT_PLANNED" });
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

  test("an OPEN pull request has no merge time — not a merge time of 1970", () => {
    // `epoch` answers 0 for an absent date, and `pullStatus` reads `mergedAt` as
    // proof a pull request landed, so a 0 here would report every open one as merged.
    const [open] = parsePulls(JSON.stringify([{ number: 1, title: "t", state: "OPEN", url: "u", updatedAt: "2026-01-01T00:00:00Z" }]));
    expect(open!.mergedAt).toBeUndefined();
    const [landed] = parsePulls(
      JSON.stringify([{ number: 2, title: "t", state: "MERGED", mergedAt: "2026-08-04T00:00:00Z", url: "u", updatedAt: "2026-08-04T00:00:00Z" }]),
    );
    expect(landed!.mergedAt).toBe(Date.parse("2026-08-04T00:00:00Z"));
  });

  test("a pull request row carries labels, which it never used to", () => {
    // The list row had none — "nothing on a 320px row had space for them" — and
    // then the row grew a second line, which is exactly where they go.
    const [pull] = parsePulls(
      JSON.stringify([
        { number: 3, title: "t", state: "OPEN", url: "u", updatedAt: "2026-01-01T00:00:00Z", labels: [{ name: "deps" }], assignees: [{ login: "ada" }] },
      ]),
    );
    expect(pull).toMatchObject({ labels: [{ name: "deps" }], assignees: ["ada"] });
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

describe("which rows a list read asks for", () => {
  /** Every `gh` call this read makes, in the order it made them. */
  async function argvFor(options: Parameters<typeof readGitHub>[3]) {
    const seen: string[][] = [];
    await readGitHub(
      async (_cwd, args) => {
        seen.push(args);
        return args[0] === "repo" ? ok(JSON.stringify({ nameWithOwner: "o/r" })) : ok("[]");
      },
      "/repo",
      () => 1,
      options,
    );
    return seen;
  }

  test("open by default, and the state travels to gh as --state", async () => {
    const seen = await argvFor(undefined);
    expect(seen.find((args) => args[0] === "issue")).toEqual([
      "issue",
      "list",
      "--state",
      "open",
      "--limit",
      "50",
      "--json",
      expect.any(String),
    ]);
  });

  test("a state PER KIND, because `merged` is not a state an issue can be in", async () => {
    // One shared filter would put a control on the Issues surface that always
    // answers nothing.
    const seen = await argvFor({ issueState: "closed", pullState: "merged" });
    const state = (verb: string) => {
      const args = seen.find((entry) => entry[0] === verb && entry[1] === "list" && entry.includes("--state"))!;
      return args[args.indexOf("--state") + 1];
    };
    expect(state("issue")).toBe("closed");
    expect(state("pr")).toBe("merged");
  });

  test("the snapshot echoes back which rows these are", async () => {
    // A surface showing forty closed issues must be able to say so. Without this it
    // would have to trust that the answer matches the filter it last sent, which a
    // thirty-second cache makes untrue.
    const snapshot = await readGitHub(
      runner({ issue: ok("[]"), pr: ok("[]"), repo: ok(JSON.stringify({ nameWithOwner: "o/r" })) }),
      "/repo",
      () => 1,
      { issueState: "all", pullState: "closed" },
    );
    expect(snapshot).toMatchObject({ issueState: "all", pullState: "closed" });
  });
});

describe("the boards, in a call that can fail alone", () => {
  const ROWS = JSON.stringify([
    { number: 7, title: "a", state: "OPEN", labels: [], updatedAt: "2026-08-01T00:00:00Z", url: "u" },
    { number: 9, title: "b", state: "OPEN", labels: [], updatedAt: "2026-08-01T00:00:00Z", url: "u" },
  ]);
  const BOARDS = JSON.stringify([
    { number: 7, projectItems: [{ title: "Roadmap" }, { title: "Sprint 4" }] },
    { number: 9, projectItems: [] },
  ]);

  /** Keyed by `<verb> <json fields>` so the board call and the row call can answer
   *  differently — which is the entire point of them being separate. */
  function boardRunner(board: GhResult): GhRunner {
    return async (_cwd, args) => {
      if (args[0] === "repo") return ok(JSON.stringify({ nameWithOwner: "o/r" }));
      const fields = args[args.indexOf("--json") + 1] ?? "";
      if (fields === "number,projectItems") return board;
      return ok(ROWS);
    };
  }

  test("board titles are folded onto the rows they belong to", async () => {
    const snapshot = await readGitHub(boardRunner(ok(BOARDS)), "/repo", () => 1);
    expect(snapshot.issues.find((issue) => issue.number === 7)!.projects).toEqual(["Roadmap", "Sprint 4"]);
    expect(snapshot.issues.find((issue) => issue.number === 9)!.projects).toEqual([]);
    expect(snapshot.projectsUnavailable).toBeUndefined();
  });

  test("A MISSING SCOPE COSTS THE COLUMN, NOT THE LIST", async () => {
    /**
     * The whole reason this is a separate call. Measured on this machine: a token
     * with `repo` and without `read:project` makes gh answer
     *
     *   GraphQL: Your token has not been granted the required scopes to execute
     *   this query. The 'id' field requires one of the following scopes:
     *   ['read:project'] …
     *
     * and it fails the ENTIRE `--json` query — so `projectItems` in the main field
     * list would blank the titles, the states and the assignees too.
     */
    const snapshot = await readGitHub(
      boardRunner(failed("GraphQL: Your token has not been granted the required scopes … ['read:project'] …")),
      "/repo",
      () => 1,
    );
    expect(snapshot.projectsUnavailable).toBe("scope");
    // The rows survived, in full.
    expect(snapshot.issues).toHaveLength(2);
    expect(snapshot.issues[0]!.title).toBe("a");
    expect(snapshot.issues[0]!.projects).toEqual([]);
    expect(snapshot.unavailable).toBeUndefined();
  });

  test("a board failure that is NOT about scopes says so differently", async () => {
    // "Add the scope" and "GitHub was unwell" need different responses.
    const snapshot = await readGitHub(boardRunner(failed("HTTP 502")), "/repo", () => 1);
    expect(snapshot.projectsUnavailable).toBe("failed");
    expect(snapshot.issues).toHaveLength(2);
  });

  test("`skipProjects` asks nothing at all, and reports no reason", async () => {
    // Once a token has said it has no read:project, the store stops paying two
    // network calls per read to be told again — and an absent column with no
    // sentence is correct, because nothing was attempted.
    const seen: string[][] = [];
    const snapshot = await readGitHub(
      async (_cwd, args) => {
        seen.push(args);
        return args[0] === "repo" ? ok(JSON.stringify({ nameWithOwner: "o/r" })) : ok(ROWS);
      },
      "/repo",
      () => 1,
      { skipProjects: true },
    );
    expect(seen.some((args) => args.includes("number,projectItems"))).toBe(false);
    expect(snapshot.projectsUnavailable).toBeUndefined();
  });

  test("output the board parser cannot read is a failure, not silently no boards", async () => {
    const snapshot = await readGitHub(boardRunner(ok("<html>")), "/repo", () => 1);
    expect(snapshot.projectsUnavailable).toBe("failed");
  });
});

describe("parseProjectItems", () => {
  test("takes the title, and drops an item that has none", () => {
    const items = parseProjectItems(
      JSON.stringify([{ number: 4, projectItems: [{ title: "Roadmap" }, { title: "" }, { project: { title: "Nested" } }] }]),
    );
    expect(items.get(4)).toEqual(["Roadmap", "Nested"]);
  });

  test("a row on no boards is absent rather than an empty array", () => {
    // The caller defaults to `[]`, so an entry per unplaced row would be a map the
    // size of the repository for no information.
    const items = parseProjectItems(JSON.stringify([{ number: 4, projectItems: [] }]));
    expect(items.has(4)).toBe(false);
  });
});

describe("classifyProjectFailure", () => {
  test("the ordinary case is a scope, and it is named", () => {
    expect(classifyProjectFailure(failed("… requires one of the following scopes: ['read:project'] …"))).toBe("scope");
    expect(classifyProjectFailure(failed("HTTP 500"))).toBe("failed");
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
