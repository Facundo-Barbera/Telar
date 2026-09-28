// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { GitHubReviewThread } from "@telar/engine-client";
import { ReviewThreadsBlock } from "./review-threads";

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;

describe("review threads", () => {
  const thread = (over: Partial<GitHubReviewThread> = {}): GitHubReviewThread => ({
    id: "PRRT_1",
    path: "apps/web/src/lib/x.ts",
    line: 42,
    diffSide: "RIGHT",
    isResolved: false,
    isOutdated: false,
    viewerCanResolve: true,
    viewerCanUnresolve: false,
    viewerCanReply: true,
    diffHunk: "@@ -1,2 +1,2 @@\n ctx\n-old\n+new",
    comments: [
      {
        author: "ada",
        body: "Off by one?",
        createdAt: NOW - HOUR,
        url: "https://github.com/o/r/pull/7#discussion_r1",
        reactions: [{ content: "EYES", count: 1, viewerHasReacted: false }],
        subjectId: "PRRC_1",
      },
    ],
    moreComments: 0,
    ...over,
  });

  test("an open thread shows its file, its line, the code it is about, and what was said", () => {
    const markup = renderToStaticMarkup(<ReviewThreadsBlock threads={[thread()]} more={0} />);
    expect(markup).toContain("apps/web/src/lib/x.ts");
    expect(markup).toContain("L42");
    expect(markup).toContain("new");
    expect(markup).toContain("Off by one?");
    expect(markup).toContain("👀");
    expect(markup).toContain("1 review thread");
  });

  test("A RESOLVED THREAD IS FOLDED to one line, never dropped", () => {
    const markup = renderToStaticMarkup(<ReviewThreadsBlock threads={[thread({ isResolved: true, resolvedBy: "grace" })]} more={0} />);
    expect(markup).toContain("resolved by grace");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("ada: Off by one?");
    expect(markup).not.toContain("<pre");
    expect(markup).toContain("1 resolved");
  });

  test("an outdated thread says so", () => {
    expect(renderToStaticMarkup(<ReviewThreadsBlock threads={[thread({ line: undefined, originalLine: 12, isOutdated: true })]} more={0} />)).toContain("outdated");
  });

  test("a read that failed SAYS it failed, rather than drawing no threads", () => {
    expect(renderToStaticMarkup(<ReviewThreadsBlock more={0} />)).toContain("could not be read");
  });

  test("a pull request nobody reviewed on the lines draws nothing at all", () => {
    expect(renderToStaticMarkup(<ReviewThreadsBlock threads={[]} more={0} />)).toBe("");
  });

  test("threads past the cap are counted, never silently dropped", () => {
    expect(renderToStaticMarkup(<ReviewThreadsBlock threads={[thread()]} more={4} />)).toContain("4 older threads are not shown");
  });
});

describe("acting on review threads (#842)", () => {
  const actions = {
    reply: async () => ({ replied: false as const, refusal: "failed" as const }),
    resolve: async () => ({ changed: false as const, refusal: "failed" as const }),
  };
  const thread = (over: Partial<GitHubReviewThread> = {}): GitHubReviewThread => ({
    id: "PRRT_1",
    path: "a.ts",
    line: 3,
    isResolved: false,
    isOutdated: false,
    viewerCanResolve: true,
    viewerCanUnresolve: false,
    viewerCanReply: true,
    diffHunk: "@@ -1 +1 @@\n+x",
    comments: [{ author: "ada", body: "hm", createdAt: NOW, url: "u1", reactions: [] }],
    moreComments: 0,
    ...over,
  });

  test("an open thread the viewer may settle offers Resolve and Reply", () => {
    const markup = renderToStaticMarkup(<ReviewThreadsBlock threads={[thread()]} more={0} actions={actions} />);
    expect(markup).toContain(">Resolve<");
    expect(markup).toContain("Reply…");
  });

  test("a resolved thread the viewer may reopen offers Unresolve", () => {
    const markup = renderToStaticMarkup(
      <ReviewThreadsBlock threads={[thread({ isResolved: true, viewerCanResolve: false, viewerCanUnresolve: true })]} more={0} actions={actions} />,
    );
    expect(markup).toContain(">Unresolve<");
  });

  test("WHAT GITHUB SAYS THIS VIEWER CANNOT DO IS NOT OFFERED — no button that can only be refused", () => {
    const markup = renderToStaticMarkup(
      <ReviewThreadsBlock threads={[thread({ viewerCanResolve: false, viewerCanReply: false })]} more={0} actions={actions} />,
    );
    expect(markup).not.toContain(">Resolve<");
    expect(markup).not.toContain("Reply…");
  });

  test("with nowhere to write, a thread is a read", () => {
    const markup = renderToStaticMarkup(<ReviewThreadsBlock threads={[thread()]} more={0} />);
    expect(markup).not.toContain(">Resolve<");
    expect(markup).not.toContain("Reply…");
  });
});
