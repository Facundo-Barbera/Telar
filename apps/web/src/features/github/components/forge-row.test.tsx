// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { GitHubPullRequest } from "@telar/engine-client";
import { renderToStaticMarkup } from "react-dom/server";
import { PullRow } from "./forge-row";

describe("a pull-request row", () => {
  const pull = (over: Partial<GitHubPullRequest> = {}): GitHubPullRequest => ({
    number: 700,
    title: "Give the merge control a home",
    state: "OPEN",
    isDraft: false,
    labels: [],
    assignees: [],
    projects: [],
    linkedIssues: [],
    updatedAt: Date.now(),
    url: "https://github.com/o/r/pull/700",
    ...over,
  });
  const row = (over: Partial<GitHubPullRequest> = {}) =>
    renderToStaticMarkup(<PullRow pull={pull(over)} mine={false} open={false} onOpen={() => {}} />);

  test("says the merge lives here, and says it without promising it", () => {
    const markup = row();
    expect(markup).toContain("merge here");
    expect(markup).not.toContain("mergeable");
    expect(markup).toContain("whether GitHub will");
  });

  test("wears the author's face beside the login, not instead of it (#790)", () => {
    const markup = row({ author: "Facundo-Barbera", authorAvatar: "https://github.com/Facundo-Barbera.png" });
    expect(markup).toContain("https://github.com/Facundo-Barbera.png?size=48");
    expect(markup).toContain("Facundo-Barbera");
    expect(markup.indexOf("open<")).toBeLessThan(markup.indexOf("size=48"));
  });

  test("and a row whose author has no face still says who filed it, over a letter", () => {
    const markup = row({ author: "app/renovate" });
    expect(markup).not.toContain("<img");
    expect(markup).toContain("app/renovate");
    expect(markup).toContain(">R<");
  });

  test("names what it closes, as a chip and not a second control", () => {
    const markup = row({ linkedIssues: [{ number: 488, url: "https://github.com/o/r/issues/488" }] });
    expect(markup).toContain("#488");
    expect(markup.split("<button").length - 1).toBe(1);
  });

  test("and a cross-repository link says whose repository, because #768 there is not #768 here", () => {
    const markup = row({ linkedIssues: [{ number: 768, url: "https://github.com/other/repo/issues/768", repository: "other/repo" }] });
    expect(markup).toContain("other/repo#768");
  });

  test("silent on the row that closes nothing, which is most of them", () => {
    const markup = row();
    expect(markup).toContain("#700");
    expect(markup).not.toContain("Linked to");
  });

  test("and is silent wherever the footer would be disabled or absent", () => {
    for (const silent of [{ isDraft: true }, { state: "MERGED" }, { state: "CLOSED" }]) {
      expect(row(silent)).toContain("#700");
      expect(row(silent)).not.toContain("merge here");
    }
  });
});
