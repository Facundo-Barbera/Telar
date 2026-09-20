/**
 * #490 — SNOOZING THE CONVERSATION YOU ARE READING CHANGES IT.
 *
 * The owner's report: *"cuando usas snooze, si estás viendo la conversación que
 * estás mandando a snooze, no cambia hasta que te sales de la conversación."*
 *
 * TWO THINGS WERE MISSING AND BOTH ARE ASSERTED HERE.
 *
 *   1. THE SCREEN HAD NO RENDERING FOR "SNOOZED" AT ALL. `isSettled` returns
 *      false for a live snooze on purpose (it is what keeps a woken session out
 *      of the settled shelf), so the settled banner could not speak for it, and
 *      nothing else on the cockpit read `snoozedUntil` except a menu item behind
 *      a closed dropdown. The first test below fails on `main` for that reason:
 *      the record changes and the screen does not.
 *   2. THE MUTATION AWAITED THE ROUND TRIP while the rail's did not. So the two
 *      surfaces moved at different speeds on the same verb. The PATCH is HELD
 *      OPEN below — the banner has to be on screen while the engine has still
 *      said nothing, which is a state a non-optimistic path cannot reach.
 *
 * WITHOUT A RE-MOUNT, A ROUTE CHANGE OR A CLOCK ADVANCE, and each of those is
 * checked rather than assumed: the same `render` call is never made twice, the
 * pathname never moves, no timer is advanced, and the composer's editor node is
 * held by IDENTITY across the press. A banner that only appeared because React
 * rebuilt the tree would be the bug wearing the fix's clothes — that is exactly
 * what "leave the conversation and come back" already did.
 *
 * ONE SESSION ID PER TEST, namespaced to this file: `sessionConnection` is a
 * module singleton shared across the whole suite, and a second opening of an id
 * tails from the cursor it already holds instead of bootstrapping (the argument
 * is written out at length in session-cockpit.solo.test.tsx).
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Session, Turn } from "@telar/engine-client";

GlobalRegistrator.register({ url: "http://localhost/projects/project_1/sessions/session_snooze_1" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// The read-receipt marker's viewport watcher, which happy-dom does not provide.
(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
  observe() {}
  disconnect() {}
  unobserve() {}
};

/** FIXED FOR THE WHOLE FILE, and never moved. Every "the screen changed"
 *  below therefore cannot be a clock tick arriving. */
const pathname = "/projects/project_1/sessions/session_snooze_1";
/** How many times the router was asked to go somewhere. A snooze that navigated
 *  would satisfy "the screen changed" for the wrong reason. */
let pushes: string[] = [];
mock.module("next/navigation", () => ({
  useRouter: () => ({
    push: (href: string) => pushes.push(href),
    replace: () => {},
    refresh: () => {},
    back: () => {},
    forward: () => {},
    prefetch: () => {},
  }),
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(),
}));

const { SessionCockpit } = await import("./session-cockpit");
const { SidebarProvider } = await import("@/components/ui/sidebar");
const { clearTranscriptCache } = await import("@/lib/transcript-cache");
const { installPageApi } = await import("@/lib/page-api");

installPageApi();

const STARTED = 1_700_000_000_000;
const ANSWER = "the conversation you are reading";

const record = (id: string, over: Partial<Session> = {}): Session =>
  ({
    id,
    title: "a conversation being put to sleep",
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
    ...over,
  }) as unknown as Session;

const turn = (id: string): Turn =>
  ({
    runId: `run_${id}`,
    sessionId: id,
    sequence: 1,
    input: "read the room",
    state: "completed",
    acceptedAt: STARTED,
    updatedAt: STARTED,
    resultText: ANSWER,
  }) as unknown as Turn;

/** Every PATCH the screen sent, and the hand that answers it. A gate rather
 *  than an immediate `Response` is the whole point: "optimistic" is only
 *  observable while the engine has not answered. */
type Patch = { body: unknown; answer: (session: Session) => void; refuse: () => void };
let patches: Patch[] = [];

function wire(id: string, over: Partial<Session> = {}) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    let body: unknown;
    try {
      body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    } catch {
      body = undefined;
    }
    if (method === "PATCH" && /\/api\/sessions\/[^/]+$/.test(url)) {
      return new Promise<Response>((resolve) => {
        patches.push({
          body,
          answer: (session) => resolve(Response.json({ session })),
          refuse: () => resolve(new Response(JSON.stringify({ error: { message: "The engine refused." } }), { status: 409 })),
        });
      });
    }
    if (url.includes("/bootstrap")) {
      return Response.json({
        session: record(id, over),
        turns: [turn(id)],
        items: [],
        tasks: [],
        requests: [],
        cursor: 1,
        events: [],
        subscriptions: [],
      });
    }
    if (url.includes("/turns")) return Response.json({ runId: "run_next", state: "queued" });
    if (url.includes("/events")) return Response.json({ events: [], cursor: 1, more: false });
    if (url.includes("/browser")) return Response.json({ browser: { tabs: [], canStart: false } });
    if (/\/projects(\?|$)/.test(url)) return Response.json({ projects: [{ id: "project_1", name: "exoplanets", root: "/tmp" }] });
    if (url.includes("/session-defaults")) return Response.json({ sessionDefaults: { envMode: "local" } });
    if (url.includes("/inbox")) return Response.json({ inbox: {} });
    if (url.includes("/models")) return Response.json({ catalogue: { models: [] } });
    return Response.json({});
  }) as typeof fetch;
}

let root: Root | undefined;
let host: HTMLDivElement | undefined;
const realFetch = globalThis.fetch;

beforeEach(() => {
  clearTranscriptCache();
  patches = [];
  pushes = [];
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
 *  waiting for a slow CI Mac (same reason as session-cockpit.solo.test.tsx). */
async function settle() {
  for (let pass = 0; pass < 8; pass += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** RENDERED ONCE PER TEST. Nothing below calls this a second time, which is what
 *  makes "no re-mount" a fact about the test rather than a hope. */
async function show(id: string) {
  window.history.replaceState(null, "", pathname);
  await act(async () => {
    root!.render(
      <SidebarProvider>
        <SessionCockpit projectId="project_1" sessionId={id} projectName="exoplanets" />
      </SidebarProvider>,
    );
  });
  await settle();
}

/** Base UI opens on pointerdown, not on a bare click. */
async function press(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true }));
    element.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
    element.click();
  });
  await settle();
}

/** The menus portal out of `host`, so every menu read is against the body. */
const menuRow = (label: string): HTMLElement | undefined =>
  [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((row) =>
    row.textContent?.replace(/\s+/g, " ").trim().startsWith(label),
  );

const composerEditor = () => host!.querySelector<HTMLElement>('[data-slot="composer-editor"]');
const sessionActions = () => host!.querySelector<HTMLElement>('[aria-label="Session actions"]');
const screenText = () => host!.textContent?.replace(/\s+/g, " ").trim() ?? "";
const wakeButton = () => [...host!.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Wake now");

const SNOOZED = "This conversation is snoozed";

/** Open the title menu, walk into Snooze, and take the first preset. The real
 *  control, not a handler reached around it — the claim is about the screen. */
async function snoozeFromTheTitleMenu() {
  const actions = sessionActions();
  expect(actions).not.toBeNull();
  await press(actions!);
  const snooze = menuRow("Snooze");
  expect(snooze).toBeDefined();
  await press(snooze!);
  const preset = menuRow("In 1 hour");
  expect(preset).toBeDefined();
  await press(preset!);
}

describe("snoozing the conversation on screen", () => {
  test("marks it immediately — before the engine has answered, and with no re-mount", async () => {
    wire("session_snooze_1");
    await show("session_snooze_1");
    expect(screenText()).toContain(ANSWER);
    // The state under test does not exist yet. Asserted rather than assumed:
    // a banner already on screen would make every check below vacuous.
    expect(screenText()).not.toContain(SNOOZED);

    // HELD BY IDENTITY. If React rebuilds this subtree, the node the screen ends
    // with is not this one, and "changed in place" was not what happened.
    const editorBefore = composerEditor();
    expect(editorBefore).not.toBeNull();

    await snoozeFromTheTitleMenu();

    // THE ENGINE HAS SAID NOTHING. One PATCH is out and still open, so anything
    // on screen now is the guess — which is the state the old path could not
    // produce at all.
    expect(patches).toHaveLength(1);
    expect(patches[0]!.body).toMatchObject({ snoozedUntil: expect.any(Number) });
    expect(screenText()).toContain(SNOOZED);
    // The wake label rides with it: "1h" for the hour preset, from `wakeLabel`.
    expect(screenText()).toMatch(/comes back to the list in \d+[mhd]/);

    // Not a navigation, and not a new tree.
    expect(pushes).toEqual([]);
    expect(composerEditor()).toBe(editorBefore!);
  });

  test("and the engine's answer keeps it there rather than replacing it", async () => {
    wire("session_snooze_2");
    await show("session_snooze_2");
    await snoozeFromTheTitleMenu();
    expect(screenText()).toContain(SNOOZED);

    const until = (patches[0]!.body as { snoozedUntil: number }).snoozedUntil;
    await act(async () => {
      patches[0]!.answer(record("session_snooze_2", { snoozedUntil: until, snoozedAt: Date.now() }));
    });
    await settle();

    // The record the engine stored, folded in, saying the same thing the guess
    // did — no flicker back to the un-snoozed screen in between.
    expect(screenText()).toContain(SNOOZED);
    // And no second read of anything to find that out.
    expect(patches).toHaveLength(1);
  });

  test("a refusal puts the screen back, rather than leaving the guess standing", async () => {
    wire("session_snooze_3");
    await show("session_snooze_3");
    await snoozeFromTheTitleMenu();
    expect(screenText()).toContain(SNOOZED);

    await act(async () => {
      patches[0]!.refuse();
    });
    await settle();

    expect(screenText()).not.toContain(SNOOZED);
    // The transcript is still there — a revert, not a blank screen.
    expect(screenText()).toContain(ANSWER);
  });

  test("the banner's own Wake returns it, and that is optimistic too", async () => {
    // Opened ALREADY ASLEEP, which is the other way to arrive here: a session
    // snoozed from the rail and then read.
    //
    // MEASURED FROM THE WALL CLOCK, NOT FROM `STARTED`. `isSnoozed` compares
    // the wake time to the screen's own `now`, and the fixture's epoch is years
    // in the past — a "three hours from STARTED" snooze is one that ran out
    // before this test was written. The transcript's stamps can be fixed; a
    // countdown cannot.
    wire("session_snooze_4", { snoozedUntil: Date.now() + 3 * 60 * 60 * 1000, snoozedAt: Date.now() });
    await show("session_snooze_4");
    expect(screenText()).toContain(SNOOZED);

    const wake = wakeButton();
    expect(wake).toBeDefined();
    await press(wake!);

    // Gone before the engine answered, and the wake is what was sent.
    expect(screenText()).not.toContain(SNOOZED);
    expect(patches).toHaveLength(1);
    expect(patches[0]!.body).toMatchObject({ snoozedUntil: null });
  });
});

/**
 * THE EXPIRED SNOOZE, which is the case that makes this a VIEW rather than a
 * stored flag. Nothing fires when a snooze runs out — the timestamp is simply in
 * the past — so a banner keyed on "is `snoozedUntil` set" would still be on
 * screen. It is keyed on `isSnoozed`, which is a comparison.
 *
 * HONESTLY LABELLED: THIS ONE PASSES ON `main` TOO, vacuously — a screen that
 * draws no snooze at all draws no stale snooze either. It is a GUARD against a
 * later `snoozedUntil !== undefined`, not a reproduction, and it is only worth
 * anything next to its positive control: `session_snooze_4` above mounts a LIVE
 * snooze and requires the banner. The pair is what makes either direction mean
 * something; the four tests above are the ones that fail on `main`.
 */
describe("a snooze that has run out", () => {
  test("draws nothing, though the timestamps are still on the record", async () => {
    wire("session_snooze_5", { snoozedUntil: STARTED - 1000, snoozedAt: STARTED - 2000 });
    await show("session_snooze_5");
    expect(screenText()).toContain(ANSWER);
    expect(screenText()).not.toContain(SNOOZED);
  });
});
