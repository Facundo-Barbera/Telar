/**
 * #497 — SWITCHING BACK TO A CONVERSATION YOU JUST READ DOES NOT BLANK.
 *
 * MOUNTED FOR REAL, and switched WITHOUT UNMOUNTING, because that is the whole
 * shape of the bug: the App Router reuses this component across
 * `/sessions/:a` → `/sessions/:b`, so between the two it sits holding the
 * previous conversation's rows with `readKey !== syncKey` — and for the length
 * of a round trip the screen shows a transcript that is not the one you asked
 * for, or nothing. A test that remounted would be testing a cold open instead.
 *
 * THE ASSERTION IS ON THE DOM IN THE COMMIT THAT SWITCHES, before any promise
 * is allowed to settle. Anything asserted after an await would also pass with
 * no cache at all, once the read landed — which is exactly the frame this is
 * about.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Session, Turn } from "@telar/engine-client";

GlobalRegistrator.register({ url: "http://localhost/projects/project_1/sessions/session_a" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// The row's viewport watcher, which this file does not exercise and happy-dom
// does not provide.
(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
  observe() {}
  disconnect() {}
  unobserve() {}
};

let pathname = "/projects/project_1/sessions/session_a";
mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(),
}));

const { SessionCockpit } = await import("./session-cockpit");
const { SidebarProvider } = await import("@/components/ui/sidebar");
const { clearTranscriptCache } = await import("@/lib/transcript-cache");

const STARTED = 1_700_000_000_000;

/** One settled turn whose result text is the thing to look for on screen. */
const turn = (id: string, said: string): Turn => ({
  runId: `run_${id}`,
  sessionId: id,
  sequence: 1,
  input: `ask ${id}`,
  state: "completed",
  acceptedAt: STARTED,
  updatedAt: STARTED,
  resultText: said,
});

/** Enough of a session for the cockpit to draw one. Everything the masthead
 *  reads is present; everything optional is left out. */
const record = (id: string): Session =>
  ({
    id,
    title: id,
    projectId: "project_1",
    environmentId: "env_1",
    state: "active",
    createdAt: STARTED,
    updatedAt: STARTED,
    providerInstanceId: "instance_1",
    driver: "claude",
    workspace: { mode: "local", path: "/tmp/project_1" },
    envMode: "local",
    runtimeMode: "standard",
    interactionMode: "interactive",
    detached: false,
    activity: "idle",
  }) as unknown as Session;

/** Every `/bootstrap` this fixture answered, so an opening can be counted. */
let opened: string[] = [];
const realFetch = globalThis.fetch;

function wire() {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    const id = /sessions\/([^/?]+)/.exec(url)?.[1] ?? "";
    if (url.includes("/bootstrap")) {
      opened.push(id);
      return Response.json({
        session: record(id),
        turns: [turn(id, `answer from ${id}`)],
        items: [],
        tasks: [],
        requests: [],
        cursor: 1,
        events: [],
        subscriptions: [],
      });
    }
    if (url.includes("/events")) return Response.json({ events: [], cursor: 1, more: false });
    if (url.includes("/browser")) return Response.json({ browser: { tabs: [], canStart: false } });
    if (url.includes("/api/projects")) return Response.json({ projects: [{ id: "project_1", name: "exoplanets", root: "/tmp" }] });
    if (url.includes("/api/session-defaults")) return Response.json({ sessionDefaults: { envMode: "local" } });
    if (url.includes("/api/inbox")) return Response.json({ inbox: {} });
    if (url.includes("/api/models")) return Response.json({ catalogue: { models: [] } });
    return Response.json({});
  }) as typeof fetch;
}

let root: Root | undefined;
let host: HTMLDivElement | undefined;

beforeEach(() => {
  clearTranscriptCache();
  opened = [];
  wire();
});

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

/**
 * Let the opening finish. The read is a promise chain behind a queue behind a
 * deferred task, so one `act` is not enough turns of the loop — and a fixed
 * sleep would be a flake waiting for a slow CI Mac.
 */
async function settle() {
  for (let pass = 0; pass < 6; pass += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Render the cockpit at one conversation, moving the address bar with it —
 *  the same pair of facts a route change hands this component. */
async function show(sessionId: string) {
  pathname = `/projects/project_1/sessions/${sessionId}`;
  await act(async () => {
    root!.render(
      <SidebarProvider>
        <SessionCockpit projectId="project_1" sessionId={sessionId} projectName="exoplanets" />
      </SidebarProvider>,
    );
  });
  await settle();
}

/** Render WITHOUT letting anything settle: the commit, and nothing after it. */
function switchTo(sessionId: string) {
  pathname = `/projects/project_1/sessions/${sessionId}`;
  act(() => {
    root!.render(
      <SidebarProvider>
        <SessionCockpit projectId="project_1" sessionId={sessionId} projectName="exoplanets" />
      </SidebarProvider>,
    );
  });
}

describe("switching back to a conversation this tab already read", () => {
  test("its transcript is on screen in the commit that switches", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    await show("session_a");
    expect(host.textContent).toContain("answer from session_a");

    await show("session_b");
    expect(host.textContent).toContain("answer from session_b");
    expect(opened).toEqual(["session_a", "session_b"]);

    // BACK, AND NOTHING IS AWAITED. Without the cache this frame holds
    // `session_b`'s transcript — the previous conversation's rows, under
    // `session_a`'s address — until a read lands.
    switchTo("session_a");
    expect(host.textContent).toContain("answer from session_a");
    expect(host.textContent).not.toContain("answer from session_b");
  });

  test("and the read behind it is a tail, not a second opening", async () => {
    /**
     * IDS OF ITS OWN, because `sessionConnection` is a module singleton that
     * outlives a test the way it outlives a switch — which is the point of it.
     * Reusing the ids above would make this pass on the first test's warm
     * connections rather than on its own.
     */
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    await show("session_c");
    await show("session_d");
    await show("session_c");
    // `/bootstrap` once per conversation: the warm connection tails from the
    // cursor it already holds rather than opening again.
    expect(opened).toEqual(["session_c", "session_d"]);
  });
});
