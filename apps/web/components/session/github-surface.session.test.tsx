/**
 * THE ROW ACTION THAT STARTS A SESSION ON AN ISSUE — issue #695.
 *
 * MOUNTED FOR REAL rather than rendered to a string, because the whole gesture is
 * effects and asynchrony: a `gh` read to draw the rows, a checkout read on the
 * press, a draft written to storage, and a push. A static render proves the
 * control EXISTS and nothing about what it does, which is why the one static
 * assertion here is the one about issues-only and the rest are mounted.
 *
 * WHAT IS BEING PINNED IS THE PROMISE, not the plumbing. The control says "a
 * worktree of its own, with this issue in the message". So: the canvas it opens
 * carries the base that arms one, the message is waiting in it, and when a
 * worktree cannot be cut nothing is opened and the reason is on screen. The
 * decision behind each of those is pinned as a decision in `lib/issue-session.test.ts`.
 *
 * `next/navigation` IS STUBBED so the push is a value this file can read rather
 * than a route the App Router would need contexts to take.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Every address the surface asked the router for, newest last. */
const pushed: string[] = [];
/** Where the reader is standing. A session's own page unless a test moves it. */
let here = "/projects/project_1/sessions/session_9";
mock.module("next/navigation", () => ({
  useRouter: () => ({ push: (href: string) => pushed.push(href), replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => here,
  useSearchParams: () => new URLSearchParams(),
}));

const { GitHubSurface } = await import("./github-surface");
const { readDraft, writeDraft } = await import("@/lib/composer-draft");

const ISSUE = {
  number: 695,
  title: "Issue → session: a row action",
  state: "OPEN",
  author: "Facundo-Barbera",
  labels: [],
  assignees: [],
  projects: [],
  linkedPulls: [],
  updatedAt: 1_700_000_000_000,
  url: "https://github.com/o/r/issues/695",
};

const PULL = { ...ISSUE, number: 700, title: "The thread reads", isDraft: false, headRefName: "telar/thread", linkedIssues: [] };

/** What `projectGit` answers. Reassigned per test; `undefined` makes it fail. */
let checkout: Record<string, unknown> | undefined;

const realFetch = globalThis.fetch;

beforeEach(() => {
  pushed.length = 0;
  here = "/projects/project_1/sessions/session_9";
  checkout = { repository: true, branch: "main", dirtyFiles: 0, worktrees: [], availability: "available", defaultBase: "origin/main" };
  window.localStorage.clear();
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/github")) {
      return Response.json({
        github: {
          issues: [ISSUE],
          pulls: [PULL],
          issueFilter: { state: "open", labels: [] },
          pullFilter: { state: "open", labels: [] },
          readAt: 1_700_000_000_000,
        },
      });
    }
    if (url.includes("/git")) {
      if (!checkout) return Response.json({ error: { code: "internal_error", message: "git did not answer." } }, { status: 500 });
      return Response.json({ git: checkout });
    }
    return Response.json({});
  }) as typeof fetch;
});

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(async () => {
  globalThis.fetch = realFetch;
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

async function mount(props: Record<string, unknown> = {}) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<GitHubSurface kind="issues" projectId="project_1" {...props} />);
  });
  // The list arrives on a `setTimeout(…, 0)`, so one turn of the loop is what
  // separates "asking gh…" from rows.
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  return host;
}

/** The row's session control, by the verb it promises rather than by its shape. */
function action(): HTMLElement {
  const found = host?.querySelector('[aria-label="Start a worktree session on #695"]');
  if (!found) throw new Error("the issue row has no session action");
  return found as HTMLElement;
}

async function press(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  // The checkout read and everything after it.
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

describe("pressing it", () => {
  test("opens the project's canvas with a worktree armed from the remote's default branch", async () => {
    await mount();
    await press(action());

    expect(pushed).toEqual(["/projects/project_1/sessions/new?base=origin%2Fmain"]);
  });

  test("leaves the issue waiting in that canvas's composer, so the first message is already written", async () => {
    await mount();
    await press(action());

    /**
     * THE CANVAS DRAFT IS THE CHANNEL, because a canvas mints no session and
     * therefore has no composer to write into yet — this is the same key the
     * composer restores from the moment it arrives.
     */
    expect(readDraft(undefined, "project_1")).toBe('#695 "Issue → session: a row action" (https://github.com/o/r/issues/695)');
  });

  test("appends to a message already being written rather than eating it", async () => {
    writeDraft(undefined, "project_1", "look at this one first:");
    await mount();
    await press(action());

    // Spaced the way a person would have typed it, trailing space included:
    // `insertReference` leaves the caret ready for the next word, and this
    // gesture goes through the identical function the row's own drag does.
    expect(readDraft(undefined, "project_1")).toBe(
      'look at this one first: #695 "Issue → session: a row action" (https://github.com/o/r/issues/695) ',
    );
  });

  test("on the very canvas it would arm, the reference goes to the live composer instead of underneath it", async () => {
    // A composer that exists owns that storage key and would overwrite anything
    // written under it on its next keystroke, so the text has to go through it.
    here = "/projects/project_1/sessions/new";
    const inserted: string[] = [];
    await mount({ onInsertReference: (text: string) => inserted.push(text) });
    await press(action());

    expect(inserted).toEqual(['#695 "Issue → session: a row action" (https://github.com/o/r/issues/695)']);
    expect(readDraft(undefined, "project_1")).toBe("");
    // Still pushed: the canvas is already open, but the base that arms the
    // worktree is not on its URL until this puts it there.
    expect(pushed).toEqual(["/projects/project_1/sessions/new?base=origin%2Fmain"]);
  });
});

describe("when a worktree cannot be cut", () => {
  test("an unplugged drive is said out loud, and nothing is opened", async () => {
    checkout = { repository: false, dirtyFiles: 0, worktrees: [], availability: "unmounted" };
    await mount();
    await press(action());

    expect(pushed).toEqual([]);
    expect(host?.textContent).toContain("is not connected. Plug it back in and this will work again.");
    // The canvas is not half-prepared either: a message waiting in a composer
    // for a session that was refused is a message somebody sends by accident.
    expect(readDraft(undefined, "project_1")).toBe("");
  });

  test("a checkout that could not be read refuses rather than opening a canvas that cannot work", async () => {
    checkout = undefined;
    await mount();
    await press(action());

    expect(pushed).toEqual([]);
    expect(host?.textContent).toContain("could not read");
  });

  test("the refusal does not take the list away — the rows are still true", async () => {
    checkout = { repository: false, dirtyFiles: 0, worktrees: [], availability: "unmounted" };
    await mount();
    await press(action());

    expect(host?.textContent).toContain("Issue → session: a row action");
  });
});

describe("where it is offered", () => {
  test("issues only: a pull request is already work, and has nothing to start", () => {
    const html = renderToStaticMarkup(<GitHubSurface kind="pulls" projectId="project_1" />);

    expect(html).not.toContain("Start a worktree session");
  });

  test("withheld without a project, because a worktree is cut from one", async () => {
    await mount({ projectId: undefined });

    expect(host?.querySelector('[aria-label="Start a worktree session on #695"]')).toBeNull();
  });
});
