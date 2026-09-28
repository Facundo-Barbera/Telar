/**
 * ARM, THEN CONFIRM — issue #670, the half a static render cannot see.
 *
 * `diff-publish.test.tsx` pins which arms EXIST in which state. This pins the
 * claim that makes them safe to have at all: **one press publishes nothing.**
 * Pushing a branch is outward-facing and only ambiguously recoverable — a
 * branch CI has already built is not un-built by deleting it — and this surface
 * lives in a panel people drag tabs around in. The merge footer took two
 * presses for the same reason; so does this.
 *
 * THE ASSERTION IS ON THE ENGINE CALL LIST, not on the markup. "The button
 * looks armed" is a claim about pixels; "nothing was sent" is the claim that
 * matters, and it is the only one that distinguishes a confirm step from a
 * label that says one.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { GitHubPullCreateResult, GitPushResult } from "@telar/engine-client";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Every engine call this surface made, in order — the recording this file is
 *  written around. */
const sent: Array<{ call: string; input?: unknown }> = [];
let pushAnswer: GitPushResult = { pushed: true, branch: "telar/670-push", commits: 2 };
let pullAnswer: GitHubPullCreateResult = {
  opened: true,
  url: "https://example.invalid/owner/repo/pull/812",
  number: 812,
  attribution: { sessionId: "session_one" },
};

/**
 * THE TWO VERBS, HANDED IN — no module mock anywhere in this file, and that is
 * deliberate rather than incidental. `mock.module("@/lib/engine/client")` is
 * PROCESS-GLOBAL in bun, and this app's suite shares one process (see the
 * `web-test-dom-release` invariant, which exists because of the same hazard):
 * replacing the engine client here replaced it for every other file that had
 * not yet imported it, and the first version of this file took eight unrelated
 * tests red with it. `PublishBox` takes its two verbs as props, so the seam is
 * the component's own and stops at this file.
 */
const sendPush = async () => {
  sent.push({ call: "push" });
  return pushAnswer;
};
const sendPullRequest = async (input: { title: string; body?: string }) => {
  sent.push({ call: "pull", input });
  return pullAnswer;
};

import { PublishBox } from "./diff-surface";

let host: HTMLElement;
let root: ReturnType<typeof createRoot> | undefined;
let published = 0;

/** Torn down before the DOM goes away — a root still mounted when
 *  `unregister()` runs reaches for a `window` that is no longer there, which
 *  the web suite's shared-process rule (`web-test-dom-release`) exists to
 *  prevent. */
afterAll(async () => {
  if (root) act(() => root!.unmount());
  await GlobalRegistrator.unregister();
});

beforeEach(() => {
  sent.length = 0;
  published = 0;
  if (root) act(() => root!.unmount());
  host?.remove();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

function render(props: Record<string, unknown> = {}) {
  act(() => {
    root!.render(
      <PublishBox
        sendPush={sendPush}
        sendPullRequest={sendPullRequest}
        branch="telar/670-push"
        commitsSinceBase={2}
        busy={false}
        suggestion="Push and PR creation from the cockpit"
        onPublished={() => {
          published += 1;
        }}
        github
        ahead={2}
        {...props}
      />,
    );
  });
}

/**
 * The button whose visible text is exactly this.
 *
 * THROWS RATHER THAN RETURNING NOTHING, so a renamed label fails loudly instead
 * of silently skipping — the shape of vacuous test this repository has been
 * caught by before.
 *
 * `await act(async …)` BECAUSE THE CONFIRMING PRESS IS ASYNCHRONOUS: it sends,
 * awaits the engine and then sets state, and a synchronous `act` returns before
 * any of that lands.
 */
async function press(label: string) {
  const button = [...host.querySelectorAll("button")].find((each) => each.textContent?.trim() === label);
  if (!button) throw new Error(`no button labelled ${label} — found ${[...host.querySelectorAll("button")].map((b) => b.textContent?.trim())}`);
  await act(async () => {
    button.click();
  });
}

const text = () => host.textContent ?? "";

describe("the push arm", () => {
  test("ONE PRESS SENDS NOTHING. It arms, names what it will do, and offers Cancel first", async () => {
    render();
    await press("Push");
    expect(sent).toEqual([]);
    expect(text()).toContain("Push telar/670-push to origin — 2 commits?");
    expect(text()).toContain("Cancel");
  });

  test("Cancel un-arms, and still nothing was sent", async () => {
    render();
    await press("Push");
    await press("Cancel");
    expect(sent).toEqual([]);
    expect(text()).not.toContain("to origin — 2 commits?");
  });

  test("the second press is the one that pushes, and the surface re-reads rather than polls", async () => {
    render();
    await press("Push");
    await press("Push");
    expect(sent).toEqual([{ call: "push" }]);
    // The moment the branch changed is the moment to look again — one read,
    // not a timer that would have found out eventually.
    expect(published).toBe(1);
  });

  test("a first push says so rather than talking about commits it cannot count", async () => {
    render({ ahead: undefined });
    await press("Push");
    expect(text()).toContain("This publishes the branch for the first time. Telar never force-pushes.");
  });

  test("A REFUSAL IS A SENTENCE, NOT A STACK TRACE, and the diverged one does not suggest a force", async () => {
    pushAnswer = { pushed: false, refusal: "rejected", message: " ! [rejected]        main -> main (fetch first)" };
    render();
    await press("Push");
    await press("Push");
    expect(text()).toContain("Pull or rebase in a terminal first");
    expect(text()).toContain("Telar will not force a push");
    // git's own words are kept underneath, never replaced with a guess.
    expect(text()).toContain("fetch first");
    expect(published).toBe(0);
    pushAnswer = { pushed: true, branch: "telar/670-push", commits: 2 };
  });

  test("nothing to push is stated plainly rather than as a failure", async () => {
    pushAnswer = { pushed: false, refusal: "nothing_to_push", message: "origin already has every commit on telar/670-push." };
    render();
    await press("Push");
    await press("Push");
    expect(text()).toContain("Nothing to push");
    pushAnswer = { pushed: true, branch: "telar/670-push", commits: 2 };
  });
});

describe("the pull-request arm", () => {
  test("ONE PRESS OPENS A COMPOSER, NOT A PULL REQUEST", async () => {
    render();
    await press("Pull request");
    expect(sent).toEqual([]);
    // The title is pre-filled from the session's own title, which is the best
    // one-line summary anybody has — the commit box's reasoning exactly.
    const title = host.querySelector<HTMLInputElement>('input[aria-label="Pull request title"]');
    expect(title?.value).toBe("Push and PR creation from the cockpit");
    expect(text()).toContain("cannot be undone from Telar");
  });

  test("the second press opens it, with the title and no empty body", async () => {
    render();
    await press("Pull request");
    await press("Open pull request");
    expect(sent).toEqual([{ call: "pull", input: { title: "Push and PR creation from the cockpit" } }]);
    expect(published).toBe(1);
    expect(text()).toContain("Opened #812");
  });

  test("ONE ALREADY OPEN IS A LINK RATHER THAN AN ERROR", async () => {
    pullAnswer = { opened: false, refusal: "exists", url: "https://example.invalid/owner/repo/pull/777" };
    render();
    await press("Pull request");
    await press("Open pull request");
    expect(text()).toContain("already open");
    expect(host.querySelector('a[href="https://example.invalid/owner/repo/pull/777"]')).not.toBeNull();
    pullAnswer = { opened: true, url: "https://example.invalid/owner/repo/pull/812", number: 812, attribution: { sessionId: "session_one" } };
  });

  test("an unpushed branch names the arm beside it as the remedy", async () => {
    pullAnswer = { opened: false, refusal: "not_pushed", message: "origin has never seen telar/670-push." };
    render();
    await press("Pull request");
    await press("Open pull request");
    expect(text()).toContain("Push it first");
    pullAnswer = { opened: true, url: "https://example.invalid/owner/repo/pull/812", number: 812, attribution: { sessionId: "session_one" } };
  });
});

describe("the two arms are two", () => {
  test("pushing never opens a pull request, and opening one never pushes", async () => {
    render();
    await press("Push");
    await press("Push");
    expect(sent.map((each) => each.call)).toEqual(["push"]);

    render();
    await press("Pull request");
    await press("Open pull request");
    expect(sent.map((each) => each.call)).toEqual(["push", "pull"]);
  });
});
