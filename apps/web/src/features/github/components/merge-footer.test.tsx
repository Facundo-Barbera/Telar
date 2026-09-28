// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { GitHubIssueDetail, GitHubPullDetail } from "@telar/engine-client";
import { MergeFooter } from "./merge-footer";

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;

const issue = (over: Partial<GitHubIssueDetail> = {}): GitHubIssueDetail =>
  ({
    number: 692,
    title: "The issue/PR thread does not read",
    url: "https://github.com/o/r/issues/692",
    state: "OPEN",
    author: "Facundo-Barbera",
    body: "Layout over data we already have.",
    createdAt: NOW - 2 * HOUR,
    updatedAt: NOW - 2 * HOUR,
    assignees: [],
    labels: [],
    projects: [],
    linkedPulls: [],
    comments: [],
    olderComments: 0,
    ...over,
  }) as GitHubIssueDetail;

const pull = (over: Partial<GitHubPullDetail> = {}): GitHubPullDetail =>
  ({
    ...issue(),
    number: 700,
    url: "https://github.com/o/r/pull/700",
    isDraft: false,
    linkedIssues: [],
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    mergeMethods: ["squash"],
    headRefName: "telar/692",
    baseRefName: "main",
    headRefOid: "abc123",
    additions: 12,
    deletions: 3,
    changedFiles: 2,
    reviews: [],
    checks: [],
    ...over,
  }) as GitHubPullDetail;

describe("the merge control", () => {
  const footer = (over: Partial<GitHubPullDetail> = {}) =>
    renderToStaticMarkup(<MergeFooter pull={pull(over)} projectId="p1" onMerged={() => {}} onReread={() => {}} />);

  test("has a home that names the branch it merges into", () => {
    expect(footer()).toContain("merge into main");
  });

  test("says whether GitHub will take it, in the state where nothing is wrong", () => {
    const markup = footer();
    expect(markup).toContain("nothing holding this back");
    expect(markup).toContain("Squash and merge");
  });

  test("still names the refusal when there is one", () => {
    expect(footer({ mergeStateStatus: "BLOCKED" })).toContain("required review");
  });

  test("keeps its home even when gh gave us no head commit to pin the merge to", () => {
    const markup = footer({ headRefOid: undefined as never });
    expect(markup).toContain("merge into main");
    expect(markup).toContain("merging is not offered");
  });

  test("a merged pull request offers nothing at all", () => {
    expect(footer({ state: "MERGED" })).toBe("");
  });
});
