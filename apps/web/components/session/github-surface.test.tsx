/**
 * THE DETAIL SUB-STRIP INSIDE THE ISSUES AND PULL-REQUEST SURFACES — issue #693.
 *
 * `lib/forge-workspace.test.ts` holds the state; these are the two claims about
 * the MARKUP that the state cannot make on its own.
 *
 * FIRST, that a surface nobody has drilled into is untouched. The move is only
 * free if it costs nothing on the common path, and an always-drawn strip holding
 * one chip reading "Issues", above a panel tab that already says Issues, is 32px
 * spent to repeat a word.
 *
 * SECOND, that the list and a detail are a SWAP rather than a stack — the list's
 * filter row is gone while an issue is open, which is what makes this a sub-strip
 * and not a drill-down with the list scrolled off above it.
 *
 * STATIC MARKUP, like `github-detail-surface.test.tsx` beside it: nothing here
 * depends on an effect or a click, and the detail behind a chip is loaded through
 * `next/dynamic`, so what this file can honestly assert is the strip and which
 * body is mounted under it.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { GitHubPullRequest } from "@telar/engine-client";
import { renderToStaticMarkup } from "react-dom/server";
import { GitHubSurface, PullRow } from "./github-surface";

const draw = (props: Parameters<typeof GitHubSurface>[0]) => renderToStaticMarkup(<GitHubSurface {...props} />);

describe("a surface nobody has drilled into", () => {
  test("draws no sub-strip at all", () => {
    const markup = draw({ kind: "issues", projectId: "p" });
    expect(markup).not.toContain('role="tablist"');
    expect(markup).not.toContain("Open issues");
  });
});

describe("the sub-strip", () => {
  const open = { numbers: [675, 666], at: 675 };

  test("holds the list as its first chip and one chip per open detail", () => {
    const markup = draw({ kind: "issues", projectId: "p", open });
    expect(markup).toContain('aria-label="Open issues"');
    // The list keeps its name; a detail wears its NUMBER, which is the shortest
    // thing that identifies it and the thing a person says out loud.
    expect(markup).toContain("Issues");
    expect(markup).toContain("#675");
    expect(markup).toContain("#666");
    // Every detail chip closes on its own; the list chip has no ×.
    expect(markup).toContain('aria-label="Close #675"');
    expect(markup).toContain('aria-label="Close #666"');
  });

  test("names the pull-request list by its own name, not 'Issues'", () => {
    const markup = draw({ kind: "pulls", projectId: "p", open: { numbers: [700] } });
    expect(markup).toContain('aria-label="Open pull requests"');
    expect(markup).toContain("Pull requests");
  });

  test("exactly one chip is selected, whichever body is showing", () => {
    const detail = draw({ kind: "issues", projectId: "p", open });
    expect(detail.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(detail).toContain('title="Issue #675"');
    // Back on the list the LIST chip is the selected one — the list is a state
    // of this surface rather than the absence of one.
    const list = draw({ kind: "issues", projectId: "p", open: { numbers: [675, 666] } });
    expect(list.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(list).toContain('title="All issues"');
  });
});

describe("the list and a detail are a swap", () => {
  test("the list is not mounted under a detail", () => {
    // Not merely scrolled out of view: a drill-down that kept the list above it
    // is the shape this surface is deliberately not. The list's own read is the
    // tell — with a detail open it has not started one (which is also why an
    // issue restored from a saved layout does not spend a `gh` call on a list
    // nobody is looking at).
    const list = draw({ kind: "issues", projectId: "p", open: { numbers: [675] } });
    expect(list).toContain("asking gh…");
    const detail = draw({ kind: "issues", projectId: "p", open: { numbers: [675], at: 675 } });
    expect(detail).not.toContain("asking gh…");
    // …and the way back is still on screen.
    expect(detail).toContain('aria-label="Open issues"');
    expect(detail).toContain('title="All issues"');
  });

  test("the surface owns its height, so a detail's pinned merge footer has a floor", () => {
    // The panel stopped scrolling this surface when it joined `OWNS_ITS_HEIGHT`;
    // an `h-full` detail inside an auto-height box is how an issue's comments
    // became unreachable once before.
    expect(draw({ kind: "pulls", projectId: "p" })).toContain("h-full");
  });
});

/**
 * THE MERGE IS ANNOUNCED IN THE LIST — issue #703.
 *
 * `lib/github-forge.test.ts` holds the rule (`offersMerge`, and why it is not and
 * cannot be a mergeability claim). This is the other half: that the rule reaches
 * the markup, which is the whole of the finding — the control existed, worked, and
 * said nothing about itself anywhere a person who did not know it existed would be.
 */
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
    // The sign points at the footer; it does not stand in for it. Anything that
    // read as a verdict would be one the list read has no fields to reach.
    expect(markup).not.toContain("mergeable");
    expect(markup).toContain("whether GitHub will");
  });

  test("wears the author's face beside the login, not instead of it (#790)", () => {
    // A login is still the thing you would say out loud; the face is what makes a
    // column of them scannable. Both, on the facts line — and NOT at the row's
    // leading edge, which the status glyph earns because it decides whether the rest
    // of the row is worth reading at all.
    const markup = row({ author: "Facundo-Barbera", authorAvatar: "https://github.com/Facundo-Barbera.png" });
    expect(markup).toContain("https://github.com/Facundo-Barbera.png?size=48");
    expect(markup).toContain("Facundo-Barbera");
    // The glyph is still first: the status label precedes the author on the line.
    expect(markup.indexOf("open<")).toBeLessThan(markup.indexOf("size=48"));
  });

  test("and a row whose author has no face still says who filed it, over a letter", () => {
    // A bot is the ordinary no-face case. The login is the answer to "who", and the
    // monogram is what keeps the row's shape identical to every row around it —
    // without it the names in a mixed list would not line up.
    const markup = row({ author: "app/renovate" });
    expect(markup).not.toContain("<img");
    expect(markup).toContain("app/renovate");
    expect(markup).toContain(">R<");
  });

  /**
   * THE ISSUE↔PR LINK, ON THE ROW — issue #790.
   *
   * A chip rather than a control, and deliberately: the row is already a `<button>`
   * and a nested one is not parseable, which is why `StartSessionAction` next door is
   * a `span[role=button]`. What a row needed was the NUMBER — "is this closed, and by
   * which PR" answered without a click at all — and the jump lives in the detail.
   */
  test("names what it closes, as a chip and not a second control", () => {
    const markup = row({ linkedIssues: [{ number: 488, url: "https://github.com/o/r/issues/488" }] });
    expect(markup).toContain("#488");
    // No nested interactive element: the only `<a>` on the row is the GitHub link
    // that has always been there, and no second `<button>` was added inside the row's.
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
    // A sign on a door that does not open teaches the capability by showing it
    // broken, which is worse than the silence it replaced.
    for (const silent of [{ isDraft: true }, { state: "MERGED" }, { state: "CLOSED" }]) {
      // The row still DREW — without this the assertion below would also pass on
      // a render that threw its way to an empty string.
      expect(row(silent)).toContain("#700");
      expect(row(silent)).not.toContain("merge here");
    }
  });
});
