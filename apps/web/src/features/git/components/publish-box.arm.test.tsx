// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { GitHubPullCreateResult, GitPushResult } from "@telar/engine-client";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sent: Array<{ call: string; input?: unknown }> = [];
let pushAnswer: GitPushResult = { pushed: true, branch: "telar/670-push", commits: 2 };
let pullAnswer: GitHubPullCreateResult = {
  opened: true,
  url: "https://example.invalid/owner/repo/pull/812",
  number: 812,
  attribution: { sessionId: "session_one" },
};

const sendPush = async () => {
  sent.push({ call: "push" });
  return pushAnswer;
};
const sendPullRequest = async (input: { title: string; body?: string }) => {
  sent.push({ call: "pull", input });
  return pullAnswer;
};

import { PublishBox } from "./publish-box";

let host: HTMLElement;
let root: ReturnType<typeof createRoot> | undefined;
let published = 0;

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
