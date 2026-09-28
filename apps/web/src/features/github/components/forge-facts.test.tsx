import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { GitHubIssueDetail, GitHubLink, GitHubPullDetail } from "@telar/engine-client";
import { ForgeFacts } from "./forge-facts";

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

describe("the facts line", () => {
  test("the facts line says who and when, once", () => {
    const markup = renderToStaticMarkup(<ForgeFacts thing={issue()} />);
    expect(markup).toContain("Facundo-Barbera");
    expect(markup).toContain("opened this");
    expect(markup.split(">Facundo-Barbera<").length - 1).toBe(1);
  });

  test("and carries the author's face, so the opening post is marked like every reply", () => {
    const markup = renderToStaticMarkup(<ForgeFacts thing={issue({ authorAvatar: "https://github.com/Facundo-Barbera.png" })} />);
    expect(markup).toContain("https://github.com/Facundo-Barbera.png?size=48");
  });
});

describe("the chips line", () => {
  test("says No labels rather than disappearing", () => {
    expect(renderToStaticMarkup(<ForgeFacts thing={issue()} />)).toContain("No labels");
  });

  test("a labelled issue says its labels instead", () => {
    const markup = renderToStaticMarkup(<ForgeFacts thing={issue({ labels: [{ name: "area:web" }] as never })} />);
    expect(markup).toContain("area:web");
    expect(markup).not.toContain("No labels");
  });

  test("the milestone and the boards still ride the same line", () => {
    const markup = renderToStaticMarkup(<ForgeFacts thing={issue({ milestone: "Wave 1", projects: ["Telar"] })} />);
    expect(markup).toContain("Wave 1");
    expect(markup).toContain("Telar");
  });
});

describe("the line that names the other end of the link", () => {
  const link = (number: number, over: Partial<GitHubLink> = {}): GitHubLink => ({
    number,
    url: `https://github.com/o/r/pull/${number}`,
    ...over,
  });
  const facts = (thing: GitHubIssueDetail | GitHubPullDetail, onOpenLinked?: (link: GitHubLink) => void) =>
    renderToStaticMarkup(<ForgeFacts thing={thing} {...(("mergeable" in thing) ? { pull: thing as GitHubPullDetail } : {})} {...(onOpenLinked ? { onOpenLinked } : {})} />);

  test("a CLOSED issue says which pull request closed it", () => {
    const markup = facts(issue({ state: "CLOSED", linkedPulls: [link(786)] }));
    expect(markup).toContain("closed by");
    expect(markup).toContain("#786");
  });

  test("an OPEN issue does NOT say it was closed by anything", () => {
    const markup = facts(issue({ state: "OPEN", linkedPulls: [link(786)] }));
    expect(markup).toContain("will close with");
    expect(markup).not.toContain("closed by");
  });

  test("a pull request says which issues it closes, which is a declaration and always true", () => {
    const markup = facts(pull({ linkedIssues: [link(488)] }));
    expect(markup).toContain("closes");
    expect(markup).toContain("#488");
  });

  test("IT IS A BUTTON, so following it stays in the cockpit", () => {
    const markup = facts(issue({ state: "CLOSED", linkedPulls: [link(786)] }), () => {});
    expect(markup).toContain('title="Open #786 here"');
    expect(markup).not.toContain('href="https://github.com/o/r/pull/786"');
  });

  test("A CROSS-REPOSITORY REFERENCE IS A LINK OUT, and says whose repository it is", () => {
    const markup = facts(issue({ state: "CLOSED", linkedPulls: [link(768, { repository: "other/repo", url: "https://github.com/other/repo/pull/768" })] }), () => {});
    expect(markup).toContain("other/repo#768");
    expect(markup).toContain('href="https://github.com/other/repo/pull/768"');
    expect(markup).not.toContain("Open #768 here");
  });

  test("with nowhere to jump to, it is still a link rather than dead text", () => {
    const markup = facts(issue({ state: "CLOSED", linkedPulls: [link(786)] }));
    expect(markup).toContain('href="https://github.com/o/r/pull/786"');
  });

  test("and the line is ABSENT on the unlinked issue, which is most of them", () => {
    const markup = facts(issue());
    expect(markup).not.toContain("will close with");
    expect(markup).not.toContain("closed by");
    expect(markup).toContain("opened this");
  });
});
