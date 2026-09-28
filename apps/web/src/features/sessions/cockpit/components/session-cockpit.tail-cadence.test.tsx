import { afterAll, afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { EngineEvent, Session, Turn } from "@telar/engine-client";

GlobalRegistrator.register({ url: "http://localhost/projects/project_1/sessions/cadence_a" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
  observe() {}
  disconnect() {}
  unobserve() {}
};

let pathname = "/projects/project_1/sessions/cadence_a";
/** Re-registered per test: `mock.module` is process-wide and the last writer
 *  wins, so a registration made at module load can be replaced by another
 *  file's before these tests run. See `perf-marks.falsify.test.tsx`. */
const mockNavigation = () =>
  mock.module("next/navigation", () => ({
    useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
    usePathname: () => pathname,
    useSearchParams: () => new URLSearchParams(),
  }));
mockNavigation();

const { SessionCockpit } = await import("./session-cockpit");
const { SidebarProvider } = await import("@/ui/sidebar");
const { clearTranscriptCache } = await import("../transcript-cache");
const { TAIL_LIVE_MS, TAIL_SETTLED_MS } = await import("@/platform/engine");

const STARTED = 1_700_000_000_000;

const WINDOW_MS = TAIL_SETTLED_MS + 200;
const LIVE_TICKS = Math.floor(WINDOW_MS / TAIL_LIVE_MS) - 1;
const SETTLED_TICKS = Math.floor(WINDOW_MS / TAIL_SETTLED_MS);

/** The rows the engine would answer a snapshot with, mutated between phases. */
let rows: Turn[] = [];
/** Journal events waiting to be drained by the next `/events` tail, exactly as
 *  the engine would hand them over. Ids continue past the opening's cursor. */
let pending: EngineEvent[] = [];
let nextEventId = 2;

const runningTurn = (runId: string): Turn => ({
  runId,
  sessionId: "cadence",
  sequence: 1,
  input: "count my requests",
  state: "running",
  acceptedAt: STARTED,
  updatedAt: STARTED,
});

const record = (id: string): Session =>
  ({
    id,
    title: "cadence",
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
    activity: rows.some((turn) => turn.state === "running") ? "working" : "idle",
  }) as unknown as Session;

function completeTheTurn(sessionId: string) {
  rows = rows.map((turn) => ({ ...turn, state: "completed" as const, resultText: "counted" }));
  pending.push({ id: nextEventId++, at: STARTED, sessionId, runId: "run_one", type: "turn.completed", resultText: "counted" } as EngineEvent);
}

/** Somebody else queues work into this conversation. */
function acceptANewTurn(sessionId: string) {
  const next = { ...runningTurn("run_two"), sequence: 2, state: "queued" as const };
  rows = [...rows, next];
  pending.push({ id: nextEventId++, at: STARTED, sessionId, runId: "run_two", type: "turn.accepted", turn: next, replayed: false } as EngineEvent);
}

/** Every `/events` tail the fixture answered — the count under test. */
let tails = 0;
const realFetch = globalThis.fetch;

function wire() {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    const id = /sessions\/([^/?]+)/.exec(url)?.[1] ?? "";
    if (url.includes("/events")) {
      tails += 1;
      const drained = pending;
      pending = [];
      return Response.json({ events: drained, cursor: Math.max(1, nextEventId - 1), more: false });
    }
    if (url.includes("/bootstrap")) {
      return Response.json({ session: record(id), turns: rows, items: [], tasks: [], requests: [], cursor: 1, events: [], subscriptions: [] });
    }
    // The companion snapshot a queue-changing event drags in.
    if (url.includes("/sessions/") && url.includes("turns=")) {
      return Response.json({ session: record(id), turns: rows, items: [], tasks: [], requests: [], cursor: nextEventId - 1 });
    }
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
  jest.useFakeTimers();
  mockNavigation();
  clearTranscriptCache();
  tails = 0;
  pending = [];
  nextEventId = 2;
  rows = [runningTurn("run_one")];
  wire();
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  jest.useRealTimers();
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

/** Let the fixture's answers resolve between clock steps. */
async function flush() {
  for (let pass = 0; pass < 20; pass += 1) await Promise.resolve();
}

/** Fake time, inside `act`, in small steps so each tick's read resolves before
 *  the next one is due, and the interval's setState lands in a commit. */
const STEP_MS = 50;
async function elapse(ms: number) {
  await act(async () => {
    let spent = 0;
    do {
      const step = Math.min(STEP_MS, ms - spent);
      jest.advanceTimersByTime(step);
      spent += step;
      await flush();
    } while (spent < ms);
  });
}

/** Let the opening's deferred tasks and promise chain drain. */
async function settle() {
  for (let pass = 0; pass < 6; pass += 1) await elapse(0);
}

async function tailsInAWindow(): Promise<number> {
  const before = tails;
  await elapse(WINDOW_MS);
  return tails - before;
}

async function open(sessionId: string) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
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

describe("how often an open cockpit re-reads the journal", () => {
  test("it tails fast while a turn runs, slowly once it settles, and fast again when one is queued", async () => {
    await open("cadence_a");

    const live = await tailsInAWindow();
    expect(live).toBeGreaterThanOrEqual(LIVE_TICKS);

    completeTheTurn("cadence_a");
    await elapse(TAIL_LIVE_MS + 600);

    const settled = await tailsInAWindow();
    expect(settled).toBeLessThanOrEqual(SETTLED_TICKS);

    expect(live).toBeGreaterThan(settled);

    acceptANewTurn("cadence_a");
    await elapse(TAIL_SETTLED_MS + 600);

    const relived = await tailsInAWindow();
    expect(relived).toBeGreaterThanOrEqual(LIVE_TICKS);
  });

  test("and the transcript is whole across the slow stretch, not merely fast to arrive", async () => {
    await open("cadence_b");

    completeTheTurn("cadence_b");
    await elapse(TAIL_LIVE_MS + 600);
    expect(host!.textContent).toContain("counted");

    // A full slow window with nothing happening.
    await elapse(WINDOW_MS);
    expect(host!.textContent).toContain("counted");

    // Then motion again, learned on the slow tail.
    acceptANewTurn("cadence_b");
    await elapse(TAIL_SETTLED_MS + 600);
    // The settled answer is intact underneath the turn that just arrived.
    expect(host!.textContent).toContain("counted");
    expect(rows).toHaveLength(2);
  });
});
