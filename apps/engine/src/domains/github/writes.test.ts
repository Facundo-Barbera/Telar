import { describe, expect, test } from "bun:test";
import { MAX_COMMENT_BODY, MAX_PULL_TITLE } from "@telar/engine-client";
import { parseSessionAttribution } from "./attribution";
import { type GhResult } from "./gh";
import { openPullRequest, parsePullNumber } from "./pulls";
import { parseComments } from "./threads";
import { classifyCommentFailure, classifyGraphqlWriteFailure, classifyMergeFailure, commentOn, mergePull, parseCommentUrl, reactionArgv, reactOn } from "./writes";
import { failed, iso, ok, verbRunner } from "./test-helpers";

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
    expect(seen.find((args) => args[1] === "merge")).toEqual(["pr", "merge", "12", "--squash", "--match-head-commit", "head-1"]);
    const merge = seen.find((args) => args[1] === "merge")!;
    expect(merge.some((arg) => ["--admin", "--auto", "--delete-branch"].includes(arg))).toBe(false);
  });

  test("REPORTS THE PULL REQUEST AS IT IS AFTER THE MERGE, re-read", async () => {
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
    const result = await mergePull(
      verbRunner({ "pr view": [mergeable(), failed("HTTP 502")], "pr merge": ok("") }, undefined),
      "/repo",
      { number: 12, method: "merge", expectedHeadOid: "head-1" },
      () => 4_242,
    );
    expect(result).toMatchObject({ merged: true, pull: { state: "MERGED", mergedAt: 4_242 } });
  });

  describe("refuses from the pull request's own fields, without asking GitHub", () => {
    const refuse = (view: GhResult, expected = "head-1") =>
      mergePull(verbRunner({ "pr view": view }), "/repo", { number: 12, method: "squash", expectedHeadOid: expected }, () => 1);

    test("a head that moved since the read", async () => {
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
      expect(await refuse(mergeable({ mergeStateStatus: "BLOCKED" }))).toMatchObject({ merged: false, refusal: "blocked" });
    });

    test("mergeability GitHub has not computed yet is NOT a refusal", async () => {
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
      expect(await refuse(failed("HTTP 502"))).toMatchObject({ merged: false, refusal: "failed", message: "HTTP 502" });
    });
  });
});

describe("classifyMergeFailure", () => {
  test("BRANCH PROTECTION WEARING THE WORDS FOR A CONFLICT is not a conflict", () => {
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
    expect(classifyMergeFailure(failed("something entirely new"))).toEqual({ refusal: "failed", message: "something entirely new" });
  });
});

describe("comment attribution", () => {
  const SESSION = "session_db5cb38d5339445aa30d5d1b2fdd71a2";
  const posted = (url: string) => ok(`${url}\n`);

  function bodyFrom(calls: string[][]): string {
    const call = calls.find((args) => args[1] === "comment");
    if (!call) throw new Error("commentOn never called gh");
    const at = call.indexOf("--body");
    return call[at + 1] ?? "";
  }

  const asThread = (body: string) => [{ body, createdAt: "2026-09-20T10:00:00Z", isMinimized: false, url: "https://example.invalid/c1" }];

  test("a comment the engine posted comes back naming the session that wrote it", async () => {
    const calls: string[][] = [];
    const result = await commentOn(verbRunner({ "issue comment": posted("https://example.invalid/issues/791#issuecomment-1") }, calls), "/repo", {
      kind: "issue",
      number: 791,
      body: "The finding, at length.",
      sessionId: SESSION,
    });

    expect(result).toEqual({
      posted: true,
      url: "https://example.invalid/issues/791#issuecomment-1",
      attribution: { sessionId: SESSION },
    });

    const read = parseComments(asThread(bodyFrom(calls)));
    expect(read.comments[0]!.attribution).toEqual({ sessionId: SESSION });
    expect(read.comments[0]!.body).toBe("The finding, at length.");
    expect(read.comments[0]!.body).not.toContain("telar-session");
  });

  test("a comment nobody stamped is attributed to nobody", () => {
    const read = parseComments(asThread("Posted by hand with `gh issue comment`."));
    expect(read.comments[0]!.attribution).toBeUndefined();
    expect(read.comments[0]!.body).toBe("Posted by hand with `gh issue comment`.");
  });

  test("nothing but the session id reaches github.com", async () => {
    const calls: string[][] = [];
    await commentOn(verbRunner({ "pr comment": posted("https://example.invalid/pull/1#issuecomment-2") }, calls), "/Volumes/Focaltec HD/live/Telar/worktree", {
      kind: "pull",
      number: 1,
      body: "Rebased onto main.",
      sessionId: SESSION,
    });
    const body = bodyFrom(calls);
    expect(body).toBe(`Rebased onto main.\n\n<!-- telar-session: ${SESSION} -->`);
    for (const forbidden of ["/Volumes", "Focaltec", "/Users", "worktree", ".local", "@"]) {
      expect(body).not.toContain(forbidden);
    }
  });

  test("a pull request comment is `pr comment`, an issue's is `issue comment`", async () => {
    const calls: string[][] = [];
    const gh = verbRunner(
      { "pr comment": posted("https://example.invalid/p"), "issue comment": posted("https://example.invalid/i") },
      calls,
    );
    await commentOn(gh, "/repo", { kind: "pull", number: 2, body: "a", sessionId: SESSION });
    await commentOn(gh, "/repo", { kind: "issue", number: 3, body: "b", sessionId: SESSION });
    expect(calls.map((args) => args.slice(0, 3).join(" "))).toEqual(["pr comment 2", "issue comment 3"]);
  });

  test("an empty or oversized body is refused before gh is asked", async () => {
    const calls: string[][] = [];
    const gh = verbRunner({ "issue comment": posted("https://example.invalid/i") }, calls);
    expect(await commentOn(gh, "/repo", { kind: "issue", number: 1, body: "   ", sessionId: SESSION })).toMatchObject({
      posted: false,
      refusal: "invalid_body",
    });
    const huge = await commentOn(gh, "/repo", { kind: "issue", number: 1, body: "x".repeat(MAX_COMMENT_BODY + 1), sessionId: SESSION });
    expect(huge).toMatchObject({ posted: false, refusal: "invalid_body" });
    expect(huge.posted === false && huge.message).toContain(String(MAX_COMMENT_BODY));
    expect(calls).toEqual([]);
  });

  test("an id that is not publishable refuses rather than posting an unstamped comment", async () => {
    const calls: string[][] = [];
    const result = await commentOn(verbRunner({ "issue comment": posted("https://example.invalid/i") }, calls), "/repo", {
      kind: "issue",
      number: 1,
      body: "a finding",
      sessionId: "/Users/facundo/Library/Application Support/Telar",
    });
    expect(result).toMatchObject({ posted: false, refusal: "invalid_body" });
    expect(calls).toEqual([]);
  });

  test("gh's refusals are named, and an unfamiliar one keeps gh's words", () => {
    expect(classifyCommentFailure(failed("GraphQL: Could not resolve to an Issue with the number of 99999")).refusal).toBe("not_found");
    expect(classifyCommentFailure(failed("HTTP 403: Resource not accessible by integration")).refusal).toBe("not_permitted");
    expect(classifyCommentFailure(failed("Issue is locked. (HTTP 403)")).refusal).toBe("not_permitted");
    expect(classifyCommentFailure(failed("something entirely new"))).toEqual({ refusal: "failed", message: "something entirely new" });
  });

  test("a comment that posted without a readable url is still reported as posted", async () => {
    const result = await commentOn(verbRunner({ "issue comment": ok("Comment created.\n") }), "/repo", {
      kind: "issue",
      number: 7,
      body: "a",
      sessionId: SESSION,
    });
    expect(result).toMatchObject({ posted: true, url: "#7", attribution: { sessionId: SESSION } });
    expect(parseCommentUrl("Comment created.\n")).toBeUndefined();
    expect(parseCommentUrl("https://example.invalid/x\n")).toBe("https://example.invalid/x");
  });
});

describe("openPullRequest", () => {
  const SESSION_ID = "session_db5cb38d5339445aa30d5d1b2fdd71a2";
  const HEAD = "telar/670-push";
  const BASE = "main";
  const OPENED = "https://github.com/NovarixHQ/Telar/pull/812";

  const open = (
    replies: Record<string, GhResult | GhResult[]>,
    calls?: string[][],
    input: Partial<Parameters<typeof openPullRequest>[2]> = {},
  ) =>
    openPullRequest(verbRunner(replies, calls), "/repo", {
      head: HEAD,
      base: BASE,
      title: "Push and PR creation from the cockpit",
      body: "What changed, and why.",
      sessionId: SESSION_ID,
      ...input,
    });

  test("the argv names both ends explicitly, and carries nothing else", async () => {
    const calls: string[][] = [];
    await open({ "pr create": ok(`${OPENED}\n`) }, calls);
    const [argv] = calls;
    expect(argv?.slice(0, 6)).toEqual(["pr", "create", "--head", HEAD, "--base", BASE]);
    expect(argv).toHaveLength(10);
    expect(argv).not.toContain("--draft");
    expect(argv).not.toContain("--fill");
    expect(argv).not.toContain("--web");
  });

  test("success carries the url and the number read out of it", async () => {
    expect(await open({ "pr create": ok(`${OPENED}\n`) })).toEqual({
      opened: true,
      url: OPENED,
      number: 812,
      attribution: { sessionId: SESSION_ID },
    });
  });

  test("the body reaches gh stamped with the session, and the marker parses back off the argv", async () => {
    const calls: string[][] = [];
    await open({ "pr create": ok(`${OPENED}\n`) }, calls);
    const body = calls[0]?.[calls[0].indexOf("--body") + 1] ?? "";
    expect(body).toContain("What changed, and why.");
    expect(parseSessionAttribution(body)).toEqual({ sessionId: SESSION_ID });
  });

  test("A PULL REQUEST THAT IS ALREADY OPEN IS A LINK, NOT AN ERROR", async () => {
    const real = failed(`a pull request for branch "${HEAD}" into branch "${BASE}" already exists:\n${OPENED}`);
    expect(await open({ "pr create": real })).toMatchObject({ opened: false, refusal: "exists", url: OPENED });
  });

  test("gh's other refusals are named, and an unfamiliar one keeps gh's words", async () => {
    expect(await open({ "pr create": failed("pull request create failed: GraphQL: No commits between main and main (createPullRequest)") })).toMatchObject({
      opened: false,
      refusal: "nothing_to_compare",
    });
    expect(await open({ "pr create": failed("GraphQL: must have admin rights to Repository. (createPullRequest)") })).toMatchObject({
      opened: false,
      refusal: "not_permitted",
    });
    expect(await open({ "pr create": failed("HTTP 403: Resource not accessible by integration") })).toMatchObject({
      opened: false,
      refusal: "not_permitted",
    });
    expect(await open({ "pr create": failed("something entirely new") })).toMatchObject({
      opened: false,
      refusal: "failed",
      message: "something entirely new",
    });
  });

  test("head === base is refused HERE, and GitHub is not asked at all", async () => {
    const calls: string[][] = [];
    expect(await open({}, calls, { base: HEAD })).toMatchObject({ opened: false, refusal: "nothing_to_compare" });
    expect(calls).toEqual([]);
  });

  test("an empty or oversized title is refused before gh is asked", async () => {
    const empty: string[][] = [];
    expect(await open({}, empty, { title: "   " })).toMatchObject({ opened: false, refusal: "invalid_title" });
    expect(empty).toEqual([]);

    const long: string[][] = [];
    const result = await open({}, long, { title: "x".repeat(MAX_PULL_TITLE + 1) });
    expect(result).toMatchObject({ opened: false, refusal: "invalid_title" });
    expect(result).toHaveProperty("message", `That title is ${MAX_PULL_TITLE + 1} characters; GitHub takes at most ${MAX_PULL_TITLE}.`);
    expect(long).toEqual([]);
  });

  test("a title exactly at the ceiling is allowed through", async () => {
    expect(await open({ "pr create": ok(`${OPENED}\n`) }, undefined, { title: "x".repeat(MAX_PULL_TITLE) })).toMatchObject({ opened: true });
  });

  test("an unpublishable session id is a typed refusal rather than a throw across the store", async () => {
    const calls: string[][] = [];
    expect(await open({}, calls, { sessionId: "../../etc/passwd" })).toMatchObject({ opened: false, refusal: "failed" });
    expect(calls).toEqual([]);
  });

  test("A PULL REQUEST THAT OPENED WITHOUT A READABLE URL IS STILL OPEN", async () => {
    const result = await open({ "pr create": ok("Creating pull request for telar/670-push into main\n") });
    expect(result).toMatchObject({ opened: true, attribution: { sessionId: SESSION_ID } });
    expect(result).not.toHaveProperty("number");
  });

  test("a number is read out of a url or left absent, never guessed", () => {
    expect(parsePullNumber(OPENED)).toBe(812);
    expect(parsePullNumber(`${OPENED}/files`)).toBe(812);
    expect(parsePullNumber("https://github.com/NovarixHQ/Telar/issues/670")).toBeUndefined();
    expect(parsePullNumber("telar/670-push → main")).toBeUndefined();
  });
});

describe("reactOn", () => {
  const answer = (mutation: string, groups: unknown[]) => ok(JSON.stringify({ data: { [mutation]: { subject: { reactionGroups: groups } } } }));

  test("adds through `addReaction`, with the id and content as VARIABLES, never query text", () => {
    const argv = reactionArgv({ subjectId: "IC_1", content: "HEART", react: true });
    expect(argv.slice(0, 2)).toEqual(["api", "graphql"]);
    expect(argv).toContain("subject=IC_1");
    expect(argv).toContain("content=HEART");
    const query = argv.find((arg) => arg.startsWith("query="))!;
    expect(query).toContain("addReaction");
    expect(query).not.toContain("IC_1");
  });

  test("removes through `removeReaction`", () => {
    expect(reactionArgv({ subjectId: "IC_1", content: "HEART", react: false }).find((arg) => arg.startsWith("query="))).toContain("removeReaction");
  });

  test("answers GitHub's count as it now stands, not the guess", async () => {
    const seen: string[][] = [];
    const result = await reactOn(
      verbRunner({ "api graphql": answer("addReaction", [{ content: "HEART", viewerHasReacted: true, users: { totalCount: 5 } }]) }, seen),
      "/repo",
      { subjectId: "IC_1", content: "HEART", react: true },
    );
    expect(result).toEqual({ reacted: true, reactions: [{ content: "HEART", count: 5, viewerHasReacted: true }] });
    expect(seen).toHaveLength(1);
  });

  test("A MISSING SCOPE IS ITS OWN REFUSAL, carrying GitHub's sentence", async () => {
    const result = await reactOn(
      verbRunner({
        "api graphql": {
          status: 1,
          stdout: JSON.stringify({
            errors: [{ type: "INSUFFICIENT_SCOPES", message: "Your token has not been granted the required scopes to execute this query." }],
          }),
          stderr: "gh: Your token has not been granted the required scopes to execute this query.",
        },
      }),
      "/repo",
      { subjectId: "IC_1", content: "HEART", react: true },
    );
    expect(result).toEqual({ reacted: false, refusal: "scope", message: "Your token has not been granted the required scopes to execute this query." });
  });

  test("a locked conversation is not_permitted, and a vanished subject is not_found", () => {
    expect(classifyGraphqlWriteFailure(failed("gh: Lock conversation is enabled; reactions are locked")).refusal).toBe("not_permitted");
    expect(classifyGraphqlWriteFailure(failed("gh: Could not resolve to a node with the global id of 'IC_1'")).refusal).toBe("not_found");
    expect(classifyGraphqlWriteFailure(failed("gh: something new")).refusal).toBe("failed");
  });

  test("exit 0 with errors and no answer is still a refusal — never a silent success", async () => {
    const result = await reactOn(
      verbRunner({ "api graphql": ok(JSON.stringify({ data: { addReaction: null }, errors: [{ message: "Resource not accessible by integration" }] })) }),
      "/repo",
      { subjectId: "IC_1", content: "HEART", react: true },
    );
    expect(result).toEqual({ reacted: false, refusal: "not_permitted", message: "Resource not accessible by integration" });
  });
});
