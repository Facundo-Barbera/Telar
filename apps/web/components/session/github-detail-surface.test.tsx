/**
 * THE ISSUE/PR THREAD READS — issue #692, §1b.
 *
 * Every test here is a way the panel stopped reading, and every one of them was
 * found by opening a real issue in the running app rather than by anything failing.
 * That is the whole reason this file exists: these are claims about rendered markup
 * — who is attributed where, what an empty metadata line says, whether the one
 * outward-facing control in this cockpit has a floor under it — and none of them can
 * be checked by reading `ForgeDetailSurface`, which does nothing but fetch before it
 * draws the pieces below.
 *
 * STATIC MARKUP, NOT A DOM. Nothing asserted here depends on an effect, a click or a
 * measurement; `renderToStaticMarkup` is the cheapest thing that answers "what does
 * this surface actually print", and a test that mounted React to ask it would be
 * slower and no more true.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { GitHubIssueDetail, GitHubLink, GitHubPullDetail } from "@telar/engine-client";
import { EntryCard, ForgeFacts, MergeFooter } from "./github-detail-surface";
import { buildForgeTimeline, type ForgeEntry } from "@/lib/github-forge";

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

const entry = (over: Partial<ForgeEntry> = {}): ForgeEntry => ({
  id: "e1",
  kind: "comment",
  at: NOW - HOUR,
  author: "Facundo-Barbera",
  body: "",
  ...over,
});

describe("the opening post", () => {
  test("carries no author bar of its own — the facts line above it is the attribution", () => {
    // The bug: the header said "Facundo-Barbera opened this 46m ago" and the first
    // card immediately repeated "Facundo-Barbera · opened this · 46m ago", so the
    // opening post read as a reply to itself, by its own author, seconds after it
    // was filed.
    const opening = buildForgeTimeline({ body: "", author: "Facundo-Barbera", createdAt: NOW - 2 * HOUR, comments: [] })[0]!;
    const markup = renderToStaticMarkup(<EntryCard entry={opening} />);
    expect(markup).not.toContain("Facundo-Barbera");
    expect(markup).not.toContain("opened this");
  });

  test("is still a card, so it is still the opening of a thread rather than loose prose", () => {
    const opening = buildForgeTimeline({ body: "", author: "Facundo-Barbera", createdAt: NOW, comments: [] })[0]!;
    expect(renderToStaticMarkup(<EntryCard entry={opening} />)).toContain("border-border");
  });

  test("its prose is capped to a measure rather than running the panel's full width", () => {
    // github.com caps its issue body and so does everything else anybody reads prose
    // in. The panel is draggable to half the screen, and the width at which a line
    // stops reading is a width somebody will choose.
    const opening = buildForgeTimeline({ body: "Layout over data we already have.", createdAt: NOW, comments: [] })[0]!;
    expect(renderToStaticMarkup(<EntryCard entry={opening} />)).toContain("max-w-[64ch]");
  });

  test("the facts line says who and when, once", () => {
    const markup = renderToStaticMarkup(<ForgeFacts thing={issue()} />);
    expect(markup).toContain("Facundo-Barbera");
    expect(markup).toContain("opened this");
    // ONE MENTION IN TEXT. The avatar's `title` carries the login too — it is how a
    // monogram says whose letter it is — so the count is of the visible name.
    expect(markup.split(">Facundo-Barbera<").length - 1).toBe(1);
  });

  test("and carries the author's face, so the opening post is marked like every reply", () => {
    // #790: the thread's one attribution had no face while the replies below it did,
    // which made the opening post the odd row out in its own thread.
    const markup = renderToStaticMarkup(<ForgeFacts thing={issue({ authorAvatar: "https://github.com/Facundo-Barbera.png" })} />);
    expect(markup).toContain("https://github.com/Facundo-Barbera.png?size=48");
  });
});

describe("a reply's author bar", () => {
  const bar = (over: Partial<ForgeEntry> = {}) => renderToStaticMarkup(<EntryCard entry={entry(over)} />);

  test("prints the time next to the name, not a column away from it", () => {
    // The bug: `ml-auto` on the timestamp. At panel width that is the full width of
    // the surface between the name and the hour it belongs to, so connecting "who"
    // to "when" cost an eye movement per card in the thread.
    const markup = bar({ url: "https://github.com/o/r/issues/692#issuecomment-1" });
    expect(markup).toContain("Facundo-Barbera");
    // The time is not the element pushed right — the link out is, and it is the
    // only one. A ragged right edge of identical glyphs is what that edge is good
    // for; a ragged right edge of dates is the thing being fixed.
    expect(markup.indexOf("ml-auto")).toBeGreaterThan(markup.indexOf("tabular-nums"));
    expect(markup.split("ml-auto").length - 1).toBe(1);
    expect(markup.slice(markup.indexOf("Open this comment on GitHub"))).toContain("ml-auto");
  });

  test("a review still says its verdict, and a plain comment still says nothing", () => {
    expect(bar({ kind: "review", state: "APPROVED" })).toContain("approved");
    expect(bar()).not.toContain("commented");
  });

  /**
   * THE FACE — issue #790, and this bar is the reason the feature exists.
   *
   * A face is decoration on a repository with twelve contributors. Here nearly every
   * comment is an agent under one account, so the author bar is a column of identical
   * logins and the face is the only mark in it a reader recognises without reading.
   */
  test("draws the author's face at the head of the bar, before the name", () => {
    const markup = bar({ avatar: "https://github.com/Facundo-Barbera.png" });
    // The size travels with the request and not with the record — one size for
    // every placement, which is what keeps a forty-comment thread to one fetch.
    expect(markup).toContain("https://github.com/Facundo-Barbera.png?size=48");
    // Before the name, not after it: the face is what the eye lands on.
    expect(markup.indexOf("size=48")).toBeLessThan(markup.indexOf("Facundo-Barbera<"));
  });

  test("an author with no face gets a LETTER, not a blank circle or a broken image", () => {
    // Absent is ordinary: a bot has no derived URL at all. A broken-image glyph
    // would read as the renderer being broken, and an empty circle says nothing.
    const markup = bar({ author: "app/renovate", avatar: undefined });
    expect(markup).not.toContain("<img");
    expect(markup).toContain(">R<");
  });

  test("the face is decorative, so a screen reader hears the name once", () => {
    // The login is right beside it in text. An `alt` naming the author again would
    // make every card in the thread say who wrote it twice.
    const markup = bar({ avatar: "https://github.com/ada.png" });
    expect(markup).toContain('alt=""');
    expect(markup).toContain('aria-hidden="true"');
  });
});

describe("the chips line", () => {
  test("says No labels rather than disappearing", () => {
    // The bug: an unlabelled issue and an issue whose labels failed to arrive
    // rendered identically — as nothing — so a bare issue looked broken.
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

/**
 * THE ISSUE↔PR LINK — issue #790. #49's design: "the single most useful thing on a
 * GitHub issue page and we do not have it."
 *
 * `lib/github-forge.test.ts` and the engine's `github.test.ts` hold the DATA; these
 * are the claims about the line — what it is called in each direction, that it is a
 * jump rather than a fourth way out of the cockpit, and that a cross-repository
 * reference is the one case where it must not be.
 */
describe("the line that names the other end of the link", () => {
  const link = (number: number, over: Partial<GitHubLink> = {}): GitHubLink => ({
    number,
    url: `https://github.com/o/r/pull/${number}`,
    ...over,
  });
  const facts = (thing: GitHubIssueDetail | GitHubPullDetail, onOpenLinked?: (link: GitHubLink) => void) =>
    renderToStaticMarkup(<ForgeFacts thing={thing} {...(("mergeable" in thing) ? { pull: thing as GitHubPullDetail } : {})} {...(onOpenLinked ? { onOpenLinked } : {})} />);

  test("a CLOSED issue says which pull request closed it", () => {
    // The evidence #790 was filed on: reading this repository meant asking "is this
    // closed, and by which PR" and answering it with `gh` by hand.
    const markup = facts(issue({ state: "CLOSED", linkedPulls: [link(786)] }));
    expect(markup).toContain("closed by");
    expect(markup).toContain("#786");
  });

  test("an OPEN issue does NOT say it was closed by anything", () => {
    /**
     * The reference is the RELATION, not the outcome — measured against cli/cli, an
     * open issue answers a reference to a pull request that closed without merging.
     * "closed by" on an open issue would claim a merge that may never happen.
     */
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
    // A URL to github.com would be a fourth way to leave. The jump ends at the
    // cockpit's own `showPanelTab("pull:786")` — the door a GitHub link in a message
    // already uses.
    const markup = facts(issue({ state: "CLOSED", linkedPulls: [link(786)] }), () => {});
    expect(markup).toContain('title="Open #786 here"');
    expect(markup).not.toContain('href="https://github.com/o/r/pull/786"');
  });

  test("A CROSS-REPOSITORY REFERENCE IS A LINK OUT, and says whose repository it is", () => {
    // The panel's Pull requests surface can only open THIS repository's numbers, so
    // a jump here would land on a different #768 entirely.
    const markup = facts(issue({ state: "CLOSED", linkedPulls: [link(768, { repository: "other/repo", url: "https://github.com/other/repo/pull/768" })] }), () => {});
    expect(markup).toContain("other/repo#768");
    expect(markup).toContain('href="https://github.com/other/repo/pull/768"');
    expect(markup).not.toContain("Open #768 here");
  });

  test("with nowhere to jump to, it is still a link rather than dead text", () => {
    // A caller with no panel — the detail rendered outside one — must still be able
    // to follow it.
    const markup = facts(issue({ state: "CLOSED", linkedPulls: [link(786)] }));
    expect(markup).toContain('href="https://github.com/o/r/pull/786"');
  });

  test("and the line is ABSENT on the unlinked issue, which is most of them", () => {
    // Unlike the chips line below it, which is drawn empty because an unlabelled
    // issue and a failed read look identical. This field rides the row read, so a
    // header that drew at all had it — there is no failure to distinguish.
    const markup = facts(issue());
    expect(markup).not.toContain("will close with");
    expect(markup).not.toContain("closed by");
    // The row still drew, so the assertions above are about the line and not about
    // a render that threw its way to an empty string.
    expect(markup).toContain("opened this");
  });
});

describe("the merge control", () => {
  const footer = (over: Partial<GitHubPullDetail> = {}) =>
    renderToStaticMarkup(<MergeFooter pull={pull(over)} projectId="p1" onMerged={() => {}} onReread={() => {}} />);

  test("has a home that names the branch it merges into", () => {
    // The finding filed with §1b: the one outward-facing write in this cockpit is
    // also the one thing nothing announces. It shipped as a green pill in the
    // bottom-left corner, over whatever the scroller happened to end on.
    expect(footer()).toContain("merge into main");
  });

  test("says whether GitHub will take it, in the state where nothing is wrong", () => {
    // The state you actually press the button in was the one state with no sentence
    // beside it: `mergeReadiness` only spoke when it was refusing.
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
    // The state badge in the header already says MERGED; a disabled button under it
    // would be explaining something nobody asked about.
    expect(footer({ state: "MERGED" })).toBe("");
  });
});

/**
 * WHICH SESSION WROTE THIS — issue #791, drawn beside the author because it is
 * the same fact: the author is the ACCOUNT, and every agent comment in this
 * repository has the same one.
 */
describe("a comment's session", () => {
  test("is a link to the conversation, beside the author who is always the same account", () => {
    const markup = renderToStaticMarkup(<EntryCard entry={entry({ author: "Facundo-Barbera", sessionId: "session_abc", body: "a finding" })} />);
    expect(markup).toContain("session_abc");
    expect(markup).toContain('href="/sessions/session_abc"');
    // A LINK, NOT A BADGE — the marker is a claim, and the honest way to draw a
    // claim is as somewhere to go and check.
    expect(markup).toContain("<a");
  });

  test("a comment with no session draws nothing at all", () => {
    // THE FAILURE DIRECTION. Without it, a card that always rendered the link
    // (with an empty id) would satisfy every assertion above.
    const markup = renderToStaticMarkup(<EntryCard entry={entry({ author: "Facundo-Barbera", body: "a finding" })} />);
    expect(markup).not.toContain("/sessions/");
    expect(markup).not.toContain("session");
  });
});
