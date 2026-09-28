/**
 * THE TWO PUBLISHING ARMS ON THE DIFF SURFACE — issue #670.
 *
 * WHAT THIS PINS, and it is one claim with three halves:
 *
 *   1. PUSH IS AVAILABLE WHERE PULL-REQUEST CREATION IS NOT. #670's
 *      investigation is explicit that folding them into one gesture makes the
 *      portable half hostage to the unportable one — a GitLab user who can push
 *      perfectly well would get one button that cannot work in place of one
 *      that can. That is a claim about MARKUP, and this is where it is checked.
 *   2. THE PULL-REQUEST ARM IS ABSENT, NOT DISABLED, where `gh` has nothing to
 *      offer. A greyed-out button is a promise this machine cannot keep and the
 *      reader has no way to find out why from here.
 *   3. NEITHER ARM ACTS ON ONE PRESS. Publishing is outward-facing and happens
 *      in a panel somebody is dragging tabs around in.
 *
 * `PublishBox`, NOT `DiffSurface`: the review arrives over a poll and a static
 * render never runs the effect that starts one. The same split
 * `diff-unknown.test.tsx` makes, for its reason — this is the half that decides
 * what a reader sees, so it is the half handed the answer.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PublishBox } from "./diff-surface";

const BRANCH = "telar/670-push";

const box = (props: Partial<Parameters<typeof PublishBox>[0]> = {}) =>
  renderToStaticMarkup(
    <PublishBox
      sendPush={async () => ({ pushed: true, branch: BRANCH })}
      sendPullRequest={async () => ({ opened: true, url: "https://example.invalid/p/1", attribution: { sessionId: "session_one" } })}
      branch={BRANCH}
      commitsSinceBase={3}
      busy={false}
      suggestion="Push and PR creation from the cockpit"
      onPublished={() => {}}
      {...props}
    />,
  );

/**
 * Whether the button carrying this label is disabled.
 *
 * THE ATTRIBUTE, NOT THE WORD. Every button in this app ships Tailwind's
 * `disabled:pointer-events-none disabled:opacity-50` in its class list, so a
 * substring search for "disabled" is true of every button ever rendered — a
 * check that would have passed whatever the component did.
 */
function disabled(markup: string, label: string): boolean {
  const chunk = markup.split("<button").find((each) => each.includes(`>${label}</button>`) || each.includes(`svg>${label}</button>`));
  if (chunk === undefined) throw new Error(`no button labelled ${label}`);
  return chunk.slice(0, chunk.indexOf(">")).includes('disabled=""');
}

describe("which arms exist", () => {
  test("push is offered with no gh anywhere, and the pull-request arm simply is not there", () => {
    // The GitLab / Gitea / bare-remote case, which is the whole reason these
    // are two arms.
    const markup = box({ github: false, ahead: 2 });
    expect(markup).toContain("Push");
    expect(markup).not.toContain("Pull request");
  });

  test("before anybody has asked gh, the second arm is hidden rather than flickering into place", () => {
    const markup = box({ ahead: 2 });
    expect(markup).toContain("Push");
    expect(markup).not.toContain("Pull request");
  });

  test("with gh available, both arms are drawn", () => {
    const markup = box({ github: true, ahead: 2 });
    expect(markup).toContain("Push");
    expect(markup).toContain("Pull request");
  });
});

describe("what each arm is allowed to do", () => {
  test("A BRANCH THE REMOTE HAS NEVER SEEN CAN BE PUSHED AND CANNOT HAVE A PULL REQUEST", () => {
    // `ahead` absent means there is no upstream at all — the ordinary state of
    // a fresh session branch, and the exact state the two arms disagree about.
    const markup = box({ github: true });
    expect(disabled(markup, "Push")).toBe(false);
    expect(disabled(markup, "Pull request")).toBe(true);
    // And it says which arm fixes it, rather than leaving a dead button.
    expect(markup).toContain("Push the branch first");
    expect(markup).toContain("origin has never seen this branch");
    expect(markup).toContain("3 commits to publish");
  });

  test("a branch level with its upstream can have a pull request and has nothing to push", () => {
    const markup = box({ github: true, ahead: 0 });
    expect(disabled(markup, "Push")).toBe(true);
    expect(disabled(markup, "Pull request")).toBe(false);
    expect(markup).toContain("origin has every commit on this branch");
  });

  test("a branch ahead of its upstream can do both", () => {
    const markup = box({ github: true, ahead: 2 });
    expect(disabled(markup, "Push")).toBe(false);
    expect(disabled(markup, "Pull request")).toBe(false);
    expect(markup).toContain("2 commits not on origin yet");
  });

  test("a running turn holds both, for the commit box's reason", () => {
    // `git add -A` mid-write commits half a file; publishing that half is the
    // same mistake one step further out.
    const markup = box({ github: true, ahead: 2, busy: true });
    expect(disabled(markup, "Push")).toBe(true);
    expect(disabled(markup, "Pull request")).toBe(true);
  });

  test("one commit is one commit, not 1 commits", () => {
    expect(box({ github: true, ahead: 1 })).toContain("1 commit not on origin yet");
    expect(box({ github: true, commitsSinceBase: 1 })).toContain("1 commit to publish");
  });
});

describe("what the surface will not offer", () => {
  test("NOTHING HERE NAMES A FORCE, and the diverged-branch remedy is a pull", () => {
    /**
     * The engine cannot force-push — the argv is fixed and
     * `scripts/source-invariants.mjs` fails the build on a second one — and a
     * surface that offered the word would be advertising something that does
     * not exist. `rejected` is the refusal where the temptation lives, so its
     * sentence is the one checked.
     */
    const markup = box({ github: true, ahead: 2 });
    for (const word of ["force", "Force", "--force", "overwrite", "Delete branch", "Discard"]) {
      expect(markup).not.toContain(word);
    }
  });

  test("the branch it will publish is named, not implied", () => {
    expect(box({ github: true, ahead: 2 })).toContain(BRANCH);
  });
});
