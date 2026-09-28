// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { GitHubLineCommentResult, GitHubPullAnchor } from "@telar/engine-client";

import { ANCHOR_REASON, anchorPullLines, applyLineComment, hunkRanges, LINE_COMMENT_REFUSAL, type LineCommentEntry, type SelectedLines } from "./pull-anchor";

const HEAD = "a".repeat(40);
const PATCH = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,4 @@\n one\n-two\n+TWO\n+2b\n three\n@@ -20,2 +21,2 @@ fn\n x\n-y\n+Y\n";
const ANCHOR: GitHubPullAnchor = {
  pull: { number: 7, url: "https://github.com/o/r/pull/7", headRefOid: HEAD, baseRefName: "main" },
  head: HEAD,
  dirty: [],
  files: [{ path: "a.ts", hunks: hunkRanges(PATCH) }],
};
const after = (start: number, end = start): SelectedLines => ({ start, end, startSide: "after", endSide: "after" });

const place = (overrides: Partial<Parameters<typeof anchorPullLines>[0]> = {}) =>
  anchorPullLines({ scope: "branch", anchor: ANCHOR, path: "a.ts", patch: PATCH, range: after(2), ...overrides });

describe("anchorPullLines", () => {
  test("a line inside the pull request's hunk is placed exactly where it was selected", () => {
    expect(place()).toEqual({ anchor: { commitId: HEAD, path: "a.ts", line: 2, side: "RIGHT" } });
  });

  test("a range carries its start, and a drag upward arrives in order", () => {
    expect(place({ range: after(3, 1) })).toEqual({ anchor: { commitId: HEAD, path: "a.ts", line: 3, side: "RIGHT", startLine: 1, startSide: "RIGHT" } });
  });

  test("a removed line is on the LEFT, and a range may cross sides", () => {
    expect(place({ range: { start: 2, end: 3, startSide: "before", endSide: "after" } })).toEqual({
      anchor: { commitId: HEAD, path: "a.ts", line: 3, side: "RIGHT", startLine: 2, startSide: "LEFT" },
    });
  });

  test("no open pull request offers nothing at all", () => {
    expect(place({ anchor: { dirty: [], files: [] } })).toBeUndefined();
  });

  test("the working-tree and turn scopes are refused", () => {
    expect(place({ scope: "unstaged" })).toEqual({ reason: ANCHOR_REASON.scope });
    expect(place({ scope: "turn" })).toEqual({ reason: ANCHOR_REASON.scope });
  });

  test("unpushed commits ask for a push; any other head mismatch says so", () => {
    const moved = { ...ANCHOR, head: "b".repeat(40) };
    expect(place({ anchor: moved, ahead: 2 })).toEqual({ reason: ANCHOR_REASON.push });
    expect(place({ anchor: moved })).toEqual({ reason: ANCHOR_REASON.head });
  });

  test("a file with uncommitted changes is refused", () => {
    expect(place({ anchor: { ...ANCHOR, dirty: ["a.ts"] } })).toEqual({ reason: ANCHOR_REASON.dirty });
  });

  test("a file outside the pull request, or without a patch there, is refused", () => {
    expect(place({ path: "b.ts" })).toEqual({ reason: ANCHOR_REASON.file });
    expect(place({ anchor: { ...ANCHOR, files: [{ path: "a.ts", hunks: [] }] } })).toEqual({ reason: ANCHOR_REASON.file });
  });

  test("a local patch whose hunks differ from GitHub's — another base — is refused", () => {
    expect(place({ patch: PATCH.replace("@@ -20,2 +21,2 @@", "@@ -19,2 +20,2 @@") })).toEqual({ reason: ANCHOR_REASON.hunks });
  });

  test("a line outside every hunk, or a range across two hunks, is refused", () => {
    expect(place({ range: after(10) })).toEqual({ reason: ANCHOR_REASON.line });
    expect(place({ range: after(2, 22) })).toEqual({ reason: ANCHOR_REASON.line });
  });
});

describe("applyLineComment", () => {
  const drawn = () => {
    const frames: (readonly LineCommentEntry[])[] = [];
    return { frames, draw: (entries: readonly LineCommentEntry[]) => frames.push(entries) };
  };

  test("pending at once, then GitHub's link", async () => {
    const { frames, draw } = drawn();
    const said = await applyLineComment({
      current: [],
      body: " Why? ",
      now: 5,
      send: async () => ({ commented: true, url: "https://github.com/o/r/pull/7#discussion_r1" }),
      draw,
    });
    expect(said).toBeUndefined();
    expect(frames).toEqual([[{ body: "Why?", at: 5 }], [{ body: "Why?", at: 5, url: "https://github.com/o/r/pull/7#discussion_r1" }]]);
  });

  test("a missing scope rolls back exactly and says the scope sentence", async () => {
    const earlier: LineCommentEntry[] = [{ body: "first", at: 1, url: "https://github.com/o/r/pull/7#discussion_r0" }];
    const { frames, draw } = drawn();
    const said = await applyLineComment({
      current: earlier,
      body: "Why?",
      now: 5,
      send: async (): Promise<GitHubLineCommentResult> => ({ commented: false, refusal: "scope" }),
      draw,
    });
    expect(said).toBe(LINE_COMMENT_REFUSAL.scope);
    expect(said).toContain("gh auth refresh -s repo");
    expect(frames.at(-1)).toBe(earlier);
  });

  test("an engine that throws rolls back too", async () => {
    const { frames, draw } = drawn();
    const said = await applyLineComment({ current: [], body: "Why?", now: 5, send: () => Promise.reject(new Error("gone")), draw });
    expect(said).toBe("gone");
    expect(frames.at(-1)).toEqual([]);
  });
});
