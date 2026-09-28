import { describe, expect, test } from "bun:test";
import { readPull } from "./detail";
import { type GhResult, type GhRunner } from "./gh";
import { parseReviewThreads } from "./threads";
import { replyToThread, resolveThread, threadReplyArgv } from "./writes";
import { failed, ok, runner, verbRunner } from "./test-helpers";

const reviewThreadsReply = (nodes: unknown[], totalCount = nodes.length) =>
  JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { totalCount, nodes } } } } });

const threadNode = (over: Record<string, unknown> = {}) => ({
  id: "PRRT_1",
  path: "apps/web/lib/x.ts",
  line: 42,
  startLine: 40,
  originalLine: 41,
  originalStartLine: 39,
  diffSide: "RIGHT",
  subjectType: "LINE",
  isResolved: false,
  isOutdated: false,
  resolvedBy: null,
  viewerCanResolve: true,
  viewerCanUnresolve: false,
  viewerCanReply: true,
  comments: {
    totalCount: 2,
    nodes: [
      {
        id: "PRRC_1",
        url: "https://github.com/o/r/pull/7#discussion_r1",
        body: "Off by one?",
        createdAt: "2026-09-01T10:00:00Z",
        diffHunk: "@@ -38,4 +38,5 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n+const c = 4;",
        authorAssociation: "MEMBER",
        author: { __typename: "User", login: "ada", avatarUrl: "https://avatars/u/1" },
        reactionGroups: [{ content: "EYES", viewerHasReacted: true, users: { totalCount: 1 } }],
      },
      {
        id: "PRRC_2",
        url: "https://github.com/o/r/pull/7#discussion_r2",
        body: "Fixed.",
        createdAt: "2026-09-01T11:00:00Z",
        diffHunk: "ignored — only the first comment's hunk is the thread's",
        author: { __typename: "Bot", login: "helper", avatarUrl: "https://avatars/in/9" },
        reactionGroups: [],
      },
    ],
  },
  ...over,
});

describe("parseReviewThreads", () => {
  test("a thread is anchored to its file and lines, with the first comment's hunk", () => {
    const read = parseReviewThreads(reviewThreadsReply([threadNode()]))!;
    expect(read.more).toBe(0);
    const [thread] = read.threads;
    expect(thread).toMatchObject({
      id: "PRRT_1",
      path: "apps/web/lib/x.ts",
      line: 42,
      startLine: 40,
      originalLine: 41,
      diffSide: "RIGHT",
      isResolved: false,
      isOutdated: false,
      viewerCanResolve: true,
      viewerCanReply: true,
      moreComments: 0,
    });
    expect(thread!.diffHunk.startsWith("@@ -38,4 +38,5 @@")).toBe(true);
    expect(thread!.comments.map((comment) => comment.body)).toEqual(["Off by one?", "Fixed."]);
  });

  test("replies carry their own reactions and node ids, and a bot's face is GitHub's", () => {
    const [thread] = parseReviewThreads(reviewThreadsReply([threadNode()]))!.threads;
    expect(thread!.comments[0]).toMatchObject({
      author: "ada",
      authorAssociation: "MEMBER",
      subjectId: "PRRC_1",
      reactions: [{ content: "EYES", count: 1, viewerHasReacted: true }],
    });
    expect(thread!.comments[1]!.authorAvatar).toBe("https://avatars/in/9");
    expect(thread!.comments[1]!.reactions).toEqual([]);
  });

  test("an OUTDATED thread has no current line and keeps where it was written", () => {
    const [thread] = parseReviewThreads(reviewThreadsReply([threadNode({ line: null, startLine: null, isOutdated: true })]))!.threads;
    expect(thread!.line).toBeUndefined();
    expect(thread!.startLine).toBeUndefined();
    expect(thread!.originalLine).toBe(41);
    expect(thread!.isOutdated).toBe(true);
  });

  test("a resolved thread is CARRIED, with who resolved it — the surface folds it, the read does not hide it", () => {
    const [thread] = parseReviewThreads(reviewThreadsReply([threadNode({ isResolved: true, resolvedBy: { login: "grace" } })]))!.threads;
    expect(thread!.isResolved).toBe(true);
    expect(thread!.resolvedBy).toBe("grace");
  });

  test("the cuts are never silent: replies past the cap, and threads past the cap", () => {
    const node = threadNode();
    (node.comments as { totalCount: number }).totalCount = 60;
    const read = parseReviewThreads(reviewThreadsReply([node], 130))!;
    expect(read.threads[0]!.moreComments).toBe(58);
    expect(read.more).toBe(129);
  });

  test("a thread with no id, no path, or no surviving comment is dropped", () => {
    const read = parseReviewThreads(
      reviewThreadsReply([threadNode({ id: null }), threadNode({ path: "" }), threadNode({ comments: { totalCount: 0, nodes: [] } })]),
    )!;
    expect(read.threads).toEqual([]);
  });

  test("an answer with no pull request in it is ABSENT, not \"no threads\"", () => {
    expect(parseReviewThreads(JSON.stringify({ data: { repository: { pullRequest: null } } }))).toBeUndefined();
    expect(parseReviewThreads(JSON.stringify({ data: null }))).toBeUndefined();
  });
});

describe("readPull carries review threads", () => {
  const runner = (threads: GhResult): GhRunner => async (_cwd, args) => {
    const key = args.slice(0, 2).join(" ");
    if (key === "pr view") return ok(JSON.stringify({ number: 7, title: "t", state: "OPEN", isDraft: false, url: "https://github.com/o/r/pull/7", createdAt: "2026-09-01T00:00:00Z" }));
    if (key === "repo view") return ok("{}");
    if (key === "api graphql") return args.some((arg) => arg.includes("reviewThreads")) ? threads : ok(JSON.stringify({ data: null }));
    return failed(`unexpected call: ${key}`);
  };

  test("a PR's threads arrive on its detail", async () => {
    const read = await readPull(runner(ok(reviewThreadsReply([threadNode()]))), "/repo", 7, () => 1, { skipProjects: true });
    if (!("pull" in read)) throw new Error(read.unavailable);
    expect(read.pull.reviewThreads).toHaveLength(1);
    expect(read.pull.moreReviewThreads).toBe(0);
  });

  test("A FAILED THREAD READ COSTS THE THREADS, NOT THE PULL REQUEST — and says so by being absent", async () => {
    const read = await readPull(runner(failed("HTTP 502")), "/repo", 7, () => 1, { skipProjects: true });
    if (!("pull" in read)) throw new Error(read.unavailable);
    expect(read.pull.number).toBe(7);
    expect(read.pull.reviewThreads).toBeUndefined();
  });
});

describe("acting on a review thread (#842)", () => {
  test("a reply's body and thread id are VARIABLES, never query text", () => {
    const argv = threadReplyArgv("PRRT_1", "looks } good {");
    expect(argv).toContain("thread=PRRT_1");
    expect(argv).toContain("body=looks } good {");
    expect(argv.find((arg) => arg.startsWith("query="))).not.toContain("looks");
  });

  test("an empty reply is refused before GitHub is asked", async () => {
    const seen: string[][] = [];
    const result = await replyToThread(verbRunner({}, seen), "/repo", { threadId: "PRRT_1", body: "   " });
    expect(result).toMatchObject({ replied: false, refusal: "invalid_body" });
    expect(seen).toHaveLength(0);
  });

  test("a reply comes back as GitHub stored it, ready to replace the pending one", async () => {
    const result = await replyToThread(
      verbRunner({
        "api graphql": ok(
          JSON.stringify({
            data: {
              addPullRequestReviewThreadReply: {
                comment: {
                  id: "PRRC_9",
                  url: "https://github.com/o/r/pull/7#discussion_r9",
                  body: "Done.",
                  createdAt: "2026-09-26T12:00:00Z",
                  author: { __typename: "User", login: "ada", avatarUrl: "https://avatars/u/1" },
                  reactionGroups: [],
                },
              },
            },
          }),
        ),
      }),
      "/repo",
      { threadId: "PRRT_1", body: " Done. " },
    );
    expect(result).toMatchObject({ replied: true, comment: { subjectId: "PRRC_9", body: "Done.", author: "ada", reactions: [] } });
  });

  test("a reply without the scope is refused as `scope`", async () => {
    const result = await replyToThread(
      verbRunner({ "api graphql": failed("gh: Your token has not been granted the required scopes to execute this query.") }),
      "/repo",
      { threadId: "PRRT_1", body: "x" },
    );
    expect(result).toMatchObject({ replied: false, refusal: "scope" });
  });

  test("resolving answers the thread's state as GitHub now holds it", async () => {
    const seen: string[][] = [];
    const result = await resolveThread(
      verbRunner(
        {
          "api graphql": ok(
            JSON.stringify({
              data: { resolveReviewThread: { thread: { isResolved: true, resolvedBy: { login: "ada" }, viewerCanResolve: false, viewerCanUnresolve: true } } },
            }),
          ),
        },
        seen,
      ),
      "/repo",
      { threadId: "PRRT_1", resolved: true },
    );
    expect(result).toEqual({ changed: true, isResolved: true, resolvedBy: "ada", viewerCanResolve: false, viewerCanUnresolve: true });
    expect(seen[0]!.find((arg) => arg.startsWith("query="))).toContain("resolveReviewThread");
  });

  test("unresolving asks `unresolveReviewThread`", async () => {
    const seen: string[][] = [];
    await resolveThread(verbRunner({ "api graphql": ok("{}") }, seen), "/repo", { threadId: "PRRT_1", resolved: false });
    expect(seen[0]!.find((arg) => arg.startsWith("query="))).toContain("unresolveReviewThread");
  });

  test("a resolve GitHub would not take is a refusal, not a silent success", async () => {
    const result = await resolveThread(
      verbRunner({ "api graphql": ok(JSON.stringify({ data: { resolveReviewThread: null }, errors: [{ message: "Resource not accessible by integration" }] })) }),
      "/repo",
      { threadId: "PRRT_1", resolved: true },
    );
    expect(result).toMatchObject({ changed: false, refusal: "not_permitted" });
  });
});
