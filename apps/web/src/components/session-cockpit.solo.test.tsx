/**
 * #576 — A CONVERSATION ON ITS OWN, FOR THE HEADSET.
 *
 * The solo route exists so a second WebView on a Quest can render ONE Telar
 * transcript and pay for nothing else. `app-shell.solo.test.tsx` holds the
 * rail's half of that; this file holds the cockpit's own: the right panel is
 * NOT IN THE TREE — not mounted at zero width, not hidden by a class — and
 * neither is any control whose only destination is a panel tab.
 *
 * AND THE CONVERSATION IS OTHERWISE UNTOUCHED, which is the other half of the
 * bargain and the easier half to break. A route that dropped the panel and took
 * the inline approvals, the send or the dictation with it would be a route the
 * headset cannot use, so each of those is exercised HERE, on the solo render,
 * rather than assumed from the ordinary page's tests.
 *
 * THE ENGINE IS A FIXTURE, the components are real. Every claim below is about
 * what this component tree does with what the engine said, so stubbing the
 * transcript or the composer would stub the thing under test.
 *
 * A SESSION ID PER TEST, AND NAMESPACED TO THIS FILE. `sessionConnection` is a
 * module singleton that outlives a test the way it outlives a navigation — a
 * second opening of the same id tails from the cursor it already holds instead
 * of bootstrapping. Within this file that reads as a blank screen; ACROSS the
 * suite, which shares one process, it silently robs another file of the very
 * `/bootstrap` it is asserting on (measured: `session_1` here left the rail's
 * prefetch test with a warm row and no read). The switch test next door keeps
 * its ids apart for the first reason; these are prefixed for the second.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { EngineRequest, Session, Turn } from "@telar/engine-client";

GlobalRegistrator.register({ url: "http://localhost/projects/project_1/sessions/session_solo_1/solo" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// The read-receipt marker's viewport watcher, which this file does not exercise
// and happy-dom does not provide.
(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
  observe() {}
  disconnect() {}
  unobserve() {}
};

let pathname = "/projects/project_1/sessions/session_solo_1/solo";
mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(),
}));

const { SessionCockpit } = await import("./session-cockpit");
const { SidebarProvider } = await import("@/components/ui/sidebar");
const { clearTranscriptCache } = await import("@/lib/transcript-cache");
const { installPageApi } = await import("@/lib/page-api");
const { activeComposer } = await import("@/lib/composer-registry");

installPageApi();

const STARTED = 1_700_000_000_000;
const ANSWER = "the transcript the headset came for";

const record = (id: string): Session =>
  ({
    id,
    title: "a conversation on its own",
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

const turn = (id: string, state: "completed" | "running"): Turn =>
  ({
    runId: `run_${id}`,
    sessionId: id,
    sequence: 1,
    input: "read the room",
    state,
    acceptedAt: STARTED,
    updatedAt: STARTED,
    ...(state === "completed" ? { resultText: ANSWER } : {}),
  }) as unknown as Turn;

/** An approval the agent is parked on — the inline card the issue names by
 *  hand, on the run that is still going so it is actionable. */
const approval = (id: string): EngineRequest =>
  ({
    id: "req_1",
    runId: `run_${id}`,
    sessionId: id,
    state: "open",
    openedAt: STARTED,
    detail: { kind: "command_execution", command: { command: "ls -la", cwd: "/tmp/project_1" } },
  }) as unknown as EngineRequest;

/** Every call this fixture answered, so a decision and a send can be looked for
 *  by the request they make rather than by a hopeful redraw. */
let calls: { method: string; url: string; body: unknown }[] = [];
const realFetch = globalThis.fetch;

function wire(id: string, options: { live?: boolean; requests?: EngineRequest[] } = {}) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    let body: unknown;
    try {
      body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    } catch {
      body = undefined;
    }
    calls.push({ method, url, body });
    if (url.includes("/bootstrap")) {
      return Response.json({
        session: record(id),
        turns: [turn(id, options.live ? "running" : "completed")],
        items: [],
        tasks: [],
        requests: options.requests ?? [],
        cursor: 1,
        events: [],
        subscriptions: [],
      });
    }
    if (url.includes("/requests/")) return Response.json({ request: { ...approval(id), state: "resolved", decision: "accept" } });
    if (url.includes("/turns")) return Response.json({ runId: "run_next", state: "queued" });
    if (url.includes("/events")) return Response.json({ events: [], cursor: 1, more: false });
    if (url.includes("/browser")) return Response.json({ browser: { tabs: [], canStart: false } });
    // MATCHED WITHOUT THE `/api` PREFIX, because a remote host rewrites every
    // one of these to `/api/hosts/<id>/…` (lib/hosts/client.ts) — and a fixture
    // that only knew the local spelling answered `{}` to the paired-Mac render,
    // which is not a missing stub but a different screen.
    if (/\/projects(\?|$)/.test(url)) return Response.json({ projects: [{ id: "project_1", name: "exoplanets", root: "/tmp" }] });
    if (url.includes("/session-defaults")) return Response.json({ sessionDefaults: { envMode: "local" } });
    if (url.includes("/inbox")) return Response.json({ inbox: {} });
    if (url.includes("/models")) return Response.json({ catalogue: { models: [] } });
    return Response.json({});
  }) as typeof fetch;
}

let root: Root | undefined;
let host: HTMLDivElement | undefined;

beforeEach(() => {
  clearTranscriptCache();
  calls = [];
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
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

/** The opening is a promise chain behind a queue behind a deferred task, so one
 *  `act` is not enough turns of the loop — and a fixed sleep would be a flake
 *  waiting for a slow CI Mac (same reason as session-cockpit.switch.test.tsx). */
async function settle() {
  for (let pass = 0; pass < 8; pass += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Render one conversation, moving the address bar with it — the same pair of
 *  facts a route change hands this component. */
async function show(id: string, { solo, hostId }: { solo: boolean; hostId?: string }) {
  const prefix = hostId ? `/hosts/${hostId}` : "";
  pathname = `${prefix}/projects/project_1/sessions/${id}${solo ? "/solo" : ""}`;
  window.history.replaceState(null, "", pathname);
  await act(async () => {
    root!.render(
      <SidebarProvider>
        <SessionCockpit projectId="project_1" sessionId={id} projectName="exoplanets" {...(solo ? { solo: true } : {})} />
      </SidebarProvider>,
    );
  });
  await settle();
}

const panel = () => host!.querySelector('[aria-label="Right panel"]');
const panelToggle = () => host!.querySelector<HTMLButtonElement>('[aria-label="Open right panel"]');
const composer = () => host!.querySelector<HTMLElement>('[data-slot="composer-editor"]');
const button = (label: string) => [...host!.querySelectorAll("button")].find((element) => element.textContent?.trim() === label);

/** THE BAR ITSELF. The cockpit's column contains exactly one `<header>` and it
 *  is the masthead, so this is the whole bar rather than a piece of it. */
const masthead = () => host!.querySelector("header");
/** The title's menu chevron — the door to rename, settle and delete. */
const sessionActions = () => host!.querySelector('[aria-label="Session actions"]');
/** The breadcrumb's link out to the project canvas (`canvasHref`). */
const canvasLink = () => host!.querySelector('a[href="/projects/project_1/sessions/new"]');
/** The Notes popover's trigger — `WorkspaceInspector`, which is the only place
 *  in the app a note can be written. */
const notes = () => host!.querySelector('[aria-label="Notes"]');
/** The run control. Its label names the state it is in — "Run this project",
 *  "Run — set up a configuration", "Run: …" — so it is matched by the stem. */
const runControl = () => host!.querySelector('[aria-label^="Run"]');

async function press(element: HTMLElement) {
  act(() => {
    element.click();
  });
  await settle();
}

describe("the solo route", () => {
  test("renders the conversation and the composer, and mounts no right panel", async () => {
    wire("session_solo_1");
    await show("session_solo_1", { solo: true });
    expect(host!.textContent).toContain(ANSWER);
    expect(composer()).not.toBeNull();
    expect(panel()).toBeNull();
    // Nor the control that would open one: absent, not disabled and not silent.
    expect(panelToggle()).toBeNull();
  });

  test("and cannot be talked into one — a restored arrangement that says `open` is still not mounted", async () => {
    /**
     * THE HOLE THIS CLOSES. The panel's arrangement is persisted per session
     * and restored after mount, so a conversation last read on the ordinary
     * route arrives here with `open: true` already written down. Withholding
     * the TOGGLE would not have been enough; the mount itself is what is gated.
     */
    localStorage.setItem(
      "telar:right-panel",
      JSON.stringify({
        version: 1,
        sessions: { session_solo_2: { tabs: [{ id: "diff", kind: "diff" }], activeTab: "diff", open: true, touchedAt: STARTED } },
      }),
    );
    wire("session_solo_2");
    await show("session_solo_2", { solo: true });
    expect(host!.textContent).toContain(ANSWER);
    expect(panel()).toBeNull();
  });

  test("the host-scoped address behaves identically", async () => {
    wire("session_solo_3");
    await show("session_solo_3", { solo: true, hostId: "mac-2" });
    expect(host!.textContent).toContain(ANSWER);
    expect(composer()).not.toBeNull();
    expect(panel()).toBeNull();
    expect(panelToggle()).toBeNull();
  });

  test("an inline request draws its accept/decline, and the decision reaches the engine", async () => {
    wire("session_solo_4", { live: true, requests: [approval("session_solo_4")] });
    await show("session_solo_4", { solo: true });

    const allow = button("Allow once");
    expect(allow).toBeDefined();
    expect(button("Deny")).toBeDefined();

    await press(allow!);
    const decided = calls.find((call) => call.method === "POST" && call.url.includes("/requests/req_1"));
    expect(decided).toBeDefined();
    expect(decided!.body).toMatchObject({ decision: "accept" });
  });

  test("dictation lands in its composer and the send goes out — the headset's whole gesture", async () => {
    wire("session_solo_5");
    await show("session_solo_5", { solo: true });

    // `window.telar` finds the box without being told which one it is; on this
    // route the solo composer is the only one mounted.
    const found = activeComposer();
    expect(found).toBeDefined();
    expect(found!.kind).toBe("session");

    const api = (window as typeof window & { telar?: { dictate: (text: string, opts?: { submit?: boolean }) => unknown } }).telar!;
    let result: unknown;
    act(() => {
      result = api.dictate("open the bay doors", { submit: true });
    });
    await settle();

    // Spaced as a paste would be — `dictate` inserts through the editor's own
    // `insertAtCaret` rather than around it, so a second sentence continues
    // this one instead of running into it (see lib/page-api.ts).
    expect(result).toMatchObject({ ok: true, draft: "open the bay doors ", submitted: true });
    const sent = calls.find((call) => call.method === "POST" && call.url.includes("/turns"));
    expect(sent).toBeDefined();
    expect(String((sent!.body as { input: string }).input).trim()).toBe("open the bay doors");
  });
});

/**
 * THE MASTHEAD, AND THE TWO CONTROLS THAT OUTLIVED IT.
 *
 * #576 shipped the solo route with the bar still on it and said so — the one
 * place its author used judgement instead of instruction. The owner has ruled
 * the other way: transcript and composer, plus the tools they need.
 *
 * SO THE BAR IS ABSENT FROM THE TREE, asserted as absence rather than as
 * invisibility, for the same reason the rail is: a collapsed rail was refused
 * at #576 precisely because it stayed mounted and in the layout, and a masthead
 * that renders empty would be the same refusal a second time.
 *
 * AND THE TWO SURVIVORS ARE REALLY THERE. Notes and Run each had exactly one
 * mount site in the app and it was inside this bar, so deleting it without
 * rehoming them would have made the headset unable to write a note or start a
 * run at all. Absence is asserted on the things that went; PRESENCE is asserted
 * on these, because "not rendered" would be the bug here.
 */
describe("the solo route carries no masthead", () => {
  test("the bar and everything cockpit-shaped in it is absent from the tree", async () => {
    wire("session_solo_7");
    await show("session_solo_7", { solo: true });
    // The conversation is still the thing on screen — this is a removal, not a
    // blank page.
    expect(host!.textContent).toContain(ANSWER);

    expect(masthead()).toBeNull();
    // The title, its menu and the rename that hangs off it.
    expect(sessionActions()).toBeNull();
    expect(host!.textContent).not.toContain("a conversation on its own");
    // The one link out of the route. Having none is the point of the route.
    expect(canvasLink()).toBeNull();
  });

  test("but Notes and Run are rehomed, not dropped — each is the last door to itself", async () => {
    wire("session_solo_8");
    await show("session_solo_8", { solo: true });
    expect(masthead()).toBeNull();
    // `WorkspaceInspector`: the only place a note can be written anywhere in
    // the app. The composer's `@` reads the same notebook and cannot write one.
    expect(notes()).not.toBeNull();
    // `RunHeaderControl`: setup, start and stop live here or nowhere.
    expect(runControl()).not.toBeNull();
  });

  test("the host-scoped address drops it too", async () => {
    wire("session_solo_9");
    await show("session_solo_9", { solo: true, hostId: "mac-2" });
    expect(host!.textContent).toContain(ANSWER);
    expect(masthead()).toBeNull();
    expect(sessionActions()).toBeNull();
    expect(notes()).not.toBeNull();
  });
});

describe("the ordinary session route — this must not leak", () => {
  test("still offers the panel, and still mounts it when asked", async () => {
    wire("session_solo_6");
    await show("session_solo_6", { solo: false });
    const toggle = panelToggle();
    expect(toggle).not.toBeNull();
    // Closed is not the same as absent: the toggle is there to be pressed.
    expect(panel()).toBeNull();

    await press(toggle!);
    expect(panel()).not.toBeNull();
  });

  test("still wears its masthead, with the title, the menu and the way back", async () => {
    wire("session_solo_10");
    await show("session_solo_10", { solo: false });
    expect(masthead()).not.toBeNull();
    expect(host!.textContent).toContain("a conversation on its own");
    expect(sessionActions()).not.toBeNull();
    expect(canvasLink()).not.toBeNull();
    // And the two that moved are still in the bar here, not duplicated out of it.
    expect(notes()).not.toBeNull();
    expect(masthead()!.contains(notes()!)).toBe(true);
    expect(masthead()!.contains(runControl()!)).toBe(true);
  });
});
