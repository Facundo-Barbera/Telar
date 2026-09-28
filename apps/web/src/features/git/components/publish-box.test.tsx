// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PublishBox } from "./publish-box";

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

function disabled(markup: string, label: string): boolean {
  const chunk = markup.split("<button").find((each) => each.includes(`>${label}</button>`) || each.includes(`svg>${label}</button>`));
  if (chunk === undefined) throw new Error(`no button labelled ${label}`);
  return chunk.slice(0, chunk.indexOf(">")).includes('disabled=""');
}

describe("which arms exist", () => {
  test("push is offered with no gh anywhere, and the pull-request arm simply is not there", () => {
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
    const markup = box({ github: true });
    expect(disabled(markup, "Push")).toBe(false);
    expect(disabled(markup, "Pull request")).toBe(true);
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
    const markup = box({ github: true, ahead: 2 });
    for (const word of ["force", "Force", "--force", "overwrite", "Delete branch", "Discard"]) {
      expect(markup).not.toContain(word);
    }
  });

  test("the branch it will publish is named, not implied", () => {
    expect(box({ github: true, ahead: 2 })).toContain(BRANCH);
  });
});
