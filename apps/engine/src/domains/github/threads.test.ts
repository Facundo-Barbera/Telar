import { describe, expect, test } from "bun:test";
import { readIssue, readPull } from "./detail";
import { type GhResult } from "./gh";
import { parseThread } from "./threads";
import { failed, iso, ok, verbRunner } from "./test-helpers";

const THREAD = "https://github.com/o/r/issues/7";
const AT = (n: number) => `${THREAD}#issuecomment-${n}`;
const APP_FACE = "https://avatars.githubusercontent.com/in/3557673?v=4";

const detail = (comments: unknown[]) =>
  ok(JSON.stringify({ number: 7, title: "t", state: "OPEN", url: THREAD, createdAt: iso(1), comments }));

const graphql = (nodes: unknown[]) => ok(JSON.stringify({ data: { repository: { issueOrPullRequest: { comments: { nodes } } } } }));

const NO_REACTIONS: unknown[] = [];

async function thread(detailReply: GhResult, graphqlReply: GhResult) {
  const read = await readIssue(verbRunner({ "issue view": detailReply, "api graphql": graphqlReply }), "/repo", 7, () => 1, {
    skipProjects: true,
  });
  if (!("issue" in read)) throw new Error(`expected an issue, got ${read.unavailable}`);
  return read.issue;
}

describe("the thread read asks GitHub who wrote each comment", () => {
  test("A BOT WEARS THE APP'S OWN FACE, never the face of whoever owns that login", async () => {
    const issue = await thread(
      detail([{ url: AT(1), body: "triaged", createdAt: iso(2), author: { login: "cli-triage" } }]),
      graphql([{ url: AT(1), author: { __typename: "Bot", login: "cli-triage", avatarUrl: APP_FACE }, reactionGroups: NO_REACTIONS }]),
    );
    expect(issue.comments).toHaveLength(1);
    expect(issue.comments[0]!.author).toBe("cli-triage");
    expect(issue.comments[0]!.authorAvatar).toBe(APP_FACE);
    expect(issue.comments[0]!.authorAvatar).not.toBe("https://github.com/cli-triage.png");
  });

  test("an App GitHub gives no face for gets NOTHING, not the slug's owner", async () => {
    const issue = await thread(
      detail([{ url: AT(1), body: "b", createdAt: iso(2), author: { login: "dependabot" } }]),
      graphql([{ url: AT(1), author: { __typename: "Bot", login: "dependabot" }, reactionGroups: NO_REACTIONS }]),
    );
    expect(issue.comments[0]!.author).toBe("dependabot");
    expect(issue.comments[0]!.authorAvatar).toBeUndefined();
  });

  test("a deleted account is an ANSWER, and it suppresses the face too", async () => {
    const issue = await thread(
      detail([{ url: AT(1), body: "b", createdAt: iso(2), author: { login: "ghost" } }]),
      graphql([{ url: AT(1), author: null, reactionGroups: NO_REACTIONS }]),
    );
    expect(issue.comments[0]!.author).toBe("ghost");
    expect(issue.comments[0]!.authorAvatar).toBeUndefined();
  });

  test("a person's face is GitHub'S OWN URL, which is what makes this work off github.com", async () => {
    const issue = await thread(
      detail([{ url: AT(1), body: "b", createdAt: iso(2), author: { login: "ada" } }]),
      graphql([
        { url: AT(1), author: { __typename: "User", login: "ada", avatarUrl: "https://avatars.githubusercontent.com/u/51800760?v=4" }, reactionGroups: NO_REACTIONS },
      ]),
    );
    expect(issue.comments[0]!.authorAvatar).toBe("https://avatars.githubusercontent.com/u/51800760?v=4");
  });

  test("A FAILED SECOND READ COSTS THE FACES, NOT THE ISSUE", async () => {
    const issue = await thread(detail([{ url: AT(1), body: "b", createdAt: iso(2), author: { login: "ada" } }]), failed("HTTP 502"));
    expect(issue.number).toBe(7);
    expect(issue.comments).toHaveLength(1);
    expect(issue.comments[0]!.authorAvatar).toBe("https://github.com/ada.png");
    expect(issue.comments[0]!.reactions).toBeUndefined();
  });

  test("output the thread read cannot be parsed from costs the faces and nothing else", async () => {
    const issue = await thread(detail([{ url: AT(1), body: "b", createdAt: iso(2), author: { login: "ada" } }]), ok("<html>"));
    expect(issue.comments).toHaveLength(1);
    expect(issue.comments[0]!.authorAvatar).toBe("https://github.com/ada.png");
  });

  test("a comment the second read did not cover keeps the derivation, beside one that was", async () => {
    const issue = await thread(
      detail([
        { url: AT(1), body: "older", createdAt: iso(2), author: { login: "ada" } },
        { url: AT(2), body: "newer", createdAt: iso(3), author: { login: "cli-triage" } },
      ]),
      graphql([{ url: AT(2), author: { __typename: "Bot", login: "cli-triage", avatarUrl: APP_FACE }, reactionGroups: NO_REACTIONS }]),
    );
    expect(issue.comments.map((entry) => entry.body)).toEqual(["older", "newer"]);
    expect(issue.comments[0]!.authorAvatar).toBe("https://github.com/ada.png");
    expect(issue.comments[1]!.authorAvatar).toBe(APP_FACE);
  });

});

describe("the thread read carries reactions", () => {
  test("REACTIONS ARRIVE COUNTED, with the groups nobody used dropped", async () => {
    const issue = await thread(
      detail([{ url: AT(1), body: "b", createdAt: iso(2), author: { login: "ada" } }]),
      graphql([
        {
          url: AT(1),
          author: { __typename: "User", login: "ada", avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4" },
          reactionGroups: [
            { content: "THUMBS_UP", viewerHasReacted: true, users: { totalCount: 3 } },
            { content: "THUMBS_DOWN", viewerHasReacted: false, users: { totalCount: 0 } },
            { content: "ROCKET", viewerHasReacted: false, users: { totalCount: 1 } },
          ],
        },
      ]),
    );
    expect(issue.comments[0]!.reactions).toEqual([
      { content: "THUMBS_UP", count: 3, viewerHasReacted: true },
      { content: "ROCKET", count: 1, viewerHasReacted: false },
    ]);
  });

  test("asked-and-nobody-reacted is `[]`, which is not the same as absent", async () => {
    const issue = await thread(
      detail([{ url: AT(1), body: "b", createdAt: iso(2), author: { login: "ada" } }]),
      graphql([
        {
          url: AT(1),
          author: { __typename: "User", login: "ada", avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4" },
          reactionGroups: [{ content: "THUMBS_UP", viewerHasReacted: false, users: { totalCount: 0 } }],
        },
      ]),
    );
    expect(issue.comments[0]!.reactions).toEqual([]);
  });

  test("a PULL REQUEST's thread is read the same way, through the same query", async () => {
    const read = await readPull(
      verbRunner({
        "pr view": ok(
          JSON.stringify({
            number: 7,
            title: "t",
            state: "OPEN",
            isDraft: false,
            url: "https://github.com/o/r/pull/7",
            createdAt: iso(1),
            comments: [{ url: AT(1), body: "b", createdAt: iso(2), author: { login: "cli-triage" } }],
          }),
        ),
        "repo view": ok("{}"),
        "api graphql": graphql([{ url: AT(1), author: { __typename: "Bot", login: "cli-triage", avatarUrl: APP_FACE }, reactionGroups: NO_REACTIONS }]),
      }),
      "/repo",
      7,
      () => 1,
      { skipProjects: true },
    );
    if (!("pull" in read)) throw new Error(`expected a pull request, got ${read.unavailable}`);
    expect(read.pull.comments[0]!.authorAvatar).toBe(APP_FACE);
  });

  test("THE ISSUE'S OWN REACTIONS ride the thread read, with the viewer's marked (#842)", async () => {
    const issue = await thread(
      detail([]),
      ok(
        JSON.stringify({
          data: {
            repository: {
              issueOrPullRequest: {
                reactionGroups: [
                  { content: "THUMBS_UP", viewerHasReacted: true, users: { totalCount: 4 } },
                  { content: "CONFUSED", viewerHasReacted: false, users: { totalCount: 0 } },
                ],
                comments: { nodes: [] },
              },
            },
          },
        }),
      ),
    );
    expect(issue.reactions).toEqual([{ content: "THUMBS_UP", count: 4, viewerHasReacted: true }]);
  });

  test("a failed thread read leaves the issue's own reactions ABSENT, never `[]`", async () => {
    const issue = await thread(detail([]), failed("HTTP 502"));
    expect(issue.reactions).toBeUndefined();
  });
});

describe("parseThread", () => {
  const nodes = (entries: unknown[]) => JSON.stringify({ data: { repository: { issueOrPullRequest: { comments: { nodes: entries } } } } });

  test("folds by url, which is the identifier the two reads share", () => {
    const { authors } = parseThread(
      nodes([
        { url: "https://github.com/o/r/issues/7#issuecomment-1", author: { __typename: "User", login: "ada", avatarUrl: "https://a/1" }, reactionGroups: [] },
        { url: "https://github.com/o/r/issues/7#issuecomment-2", author: { __typename: "Bot", login: "app", avatarUrl: "https://a/in/2" }, reactionGroups: [] },
      ]),
    );
    expect(authors.size).toBe(2);
    expect(authors.get("https://github.com/o/r/issues/7#issuecomment-1")).toEqual({ login: "ada", avatarUrl: "https://a/1", reactions: [] });
    expect(authors.get("https://github.com/o/r/issues/7#issuecomment-2")!.avatarUrl).toBe("https://a/in/2");
  });

  test("a node with no url cannot be folded onto anything, and is dropped", () => {
    expect(parseThread(nodes([{ author: { __typename: "User", login: "ada", avatarUrl: "https://a/1" } }])).authors.size).toBe(0);
  });

  test("a null author is still an entry — GitHub answered, and the answer is nobody", () => {
    const { authors } = parseThread(nodes([{ url: "c1", author: null, reactionGroups: [] }]));
    expect(authors.has("c1")).toBe(true);
    expect(authors.get("c1")).toEqual({ reactions: [] });
  });

  test("an answer with no thread in it is an empty map, not a throw", () => {
    expect(parseThread(JSON.stringify({ data: { repository: { issueOrPullRequest: null } } })).authors.size).toBe(0);
    expect(parseThread(JSON.stringify({ data: null })).authors.size).toBe(0);
  });

  test("the thing's OWN reactions are read beside its comments, empty groups dropped", () => {
    const read = parseThread(
      JSON.stringify({
        data: {
          repository: {
            issueOrPullRequest: {
              reactionGroups: [
                { content: "HEART", viewerHasReacted: true, users: { totalCount: 2 } },
                { content: "EYES", viewerHasReacted: false, users: { totalCount: 0 } },
              ],
              comments: { nodes: [] },
            },
          },
        },
      }),
    );
    expect(read.reactions).toEqual([{ content: "HEART", count: 2, viewerHasReacted: true }]);
  });

  test("node ids travel so a reaction has something to be written against", () => {
    const read = parseThread(
      JSON.stringify({
        data: {
          repository: {
            issueOrPullRequest: {
              id: "I_kwDOabc",
              reactionGroups: [],
              comments: { nodes: [{ id: "IC_kwDOdef", url: "c1", author: null, reactionGroups: [] }] },
            },
          },
        },
      }),
    );
    expect(read.subjectId).toBe("I_kwDOabc");
    expect(read.authors.get("c1")!.subjectId).toBe("IC_kwDOdef");
  });

  test("an id no GitHub node has ever looked like is dropped, not carried to a write", () => {
    const read = parseThread(JSON.stringify({ data: { repository: { issueOrPullRequest: { id: "x y; drop", comments: { nodes: [] } } } } }));
    expect(read.subjectId).toBeUndefined();
  });

  test("no `reactionGroups` in the answer is ABSENT, not \"nobody reacted\"", () => {
    expect(parseThread(nodes([])).reactions).toBeUndefined();
    expect(parseThread(JSON.stringify({ data: null })).reactions).toBeUndefined();
  });
});
