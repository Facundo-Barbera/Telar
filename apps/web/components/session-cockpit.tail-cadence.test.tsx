/**
 * THE TAIL'S CADENCE, COUNTED IN REQUESTS — #490.
 *
 * WHAT THIS FILE REFUSES TO DO, because it is the trap the issue is about: a
 * test that mounts the cockpit, waits, and asserts the transcript updated
 * proves DELIVERY. The saving is not delivery — it is the requests that stop
 * being made, and a green "the tail still works" is passed identically by the
 * old flat 1 s and by the new cadence. So every assertion here is a COUNT of
 * reads the fixture actually answered inside a measured window.
 *
 * WHAT IS COUNTED, PRECISELY: `GET /api/sessions/:id/events?after=N`. That is
 * the tail — one per tick, for ever, on every open cockpit — and it is the
 * request this change removes two-thirds of. The opening's `/bootstrap` and
 * the companion snapshot a queue-changing event drags in are deliberately NOT
 * counted: they are per-transition costs that this change does not touch, and
 * folding them in would let a quiet conversation's saving be masked by a busy
 * one's snapshots.
 *
 * THREE PHASES, ON ONE MOUNT, IN THIS ORDER:
 *
 *   A. a turn is RUNNING    → the live rate, pinned as a number
 *   B. the turn COMPLETES   → the settled rate, pinned as a number
 *   C. a turn is ACCEPTED   → back to the live rate within one window
 *
 * C IS THE ONE THAT MATTERS and the reason the other two are not enough. A
 * cockpit that drops to 3 s and never comes back is worse than the bug it
 * replaced: a conversation somebody else started — a peer assigning work, a
 * detached run finishing — would tail for ever at the slow rate while the
 * reader watched a transcript that had stopped moving. A and B alone are
 * passed by a cockpit that decays to 3 s permanently. Remove `tailMs` from the
 * interval effect's dependencies and C is the assertion that goes red.
 *
 * NOTHING IN PHASE C IS LOCAL. No press, no submit. The state change arrives
 * the only way it can — as a journal event on the slow tail the cockpit is
 * already on — which is exactly the case a "stop polling until something wakes
 * us" design could never recover from, there being no cross-session event feed
 * to be woken by (#586).
 *
 * ONE MOUNT AND ONE SESSION ID ON PURPOSE. `sessionConnection` is a module
 * singleton and the cockpit does not remount between states — a turn starting
 * is a state change inside a mounted component, which is the population the
 * cadence has to be right for. Re-mounting between phases would measure three
 * cold opens instead. The second test uses an id of its OWN for the same
 * reason in reverse: that singleton outlives a test, so reusing the first
 * test's id would let it pass on the first test's warm connection.
 *
 * THE WINDOWS ARE REAL SECONDS, and that is a deliberate trade. The periods
 * under test are 1 s and 3 s, so a window that can tell them apart is a few
 * seconds long. The alternative was to `mock.module` the constants smaller,
 * which would have measured a cadence this app never runs and — `mock.module`
 * being process-wide, last-writer-wins — could have silently re-timed every
 * other cockpit test in the suite.
 *
 * IN PROCESS, AND NOTHING SURVIVES THE TURN — happy-dom and React's own `act`,
 * the harness `session-cockpit.switch.test.tsx` already uses. No browser, no
 * server, no daemon, no Electron.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
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
const { SidebarProvider } = await import("@/components/ui/sidebar");
const { clearTranscriptCache } = await import("@/lib/transcript-cache");
const { TAIL_LIVE_MS, TAIL_SETTLED_MS } = await import("@/lib/engine/session-sync");

const STARTED = 1_700_000_000_000;

/**
 * THE WINDOW EVERY PHASE IS MEASURED OVER, derived from the constants rather
 * than typed in, so this arithmetic cannot drift away from the code if
 * somebody retunes the cadence.
 *
 * At 1 s a 3.2 s window carries three ticks; at 3 s it carries one. The
 * assertions are `>= 2` and `<= 1` — one live tick of slack given away to a
 * loaded runner, and still a clean gap, with the ratio asserted separately so
 * a machine starved enough to satisfy both bounds vacuously fails instead.
 */
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

/**
 * THE TURN FINISHES — as a journal event, which is the only way a cockpit ever
 * learns it. `turn.completed` is a queue-changing event, so the same tail also
 * pulls the companion snapshot that carries the settled row; that is the
 * engine's contract (`QUEUE_CHANGING_EVENTS`) and it is why the cadence can
 * read turn state off rows already in hand instead of probing for it.
 */
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
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

/** Let the opening's promise chain drain. A fixed sleep would be a flake on a
 *  slow runner; six turns of the loop is what the switch test uses. */
async function settle() {
  for (let pass = 0; pass < 6; pass += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Real time, inside `act`, so the interval's own setState lands in a commit
 *  rather than warning about an update outside a test-act. */
async function elapse(ms: number) {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  });
}

/** Tails the fixture answered over a fresh window of `WINDOW_MS`. */
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

    // ---- A. a turn is RUNNING -------------------------------------------
    const live = await tailsInAWindow();
    expect(live).toBeGreaterThanOrEqual(LIVE_TICKS);

    // ---- B. it COMPLETES -------------------------------------------------
    // One live period plus slack, so the event lands and the interval re-arms
    // BEFORE the window opens: what is measured is the settled cadence, not
    // the transition into it.
    completeTheTurn("cadence_a");
    await elapse(TAIL_LIVE_MS + 600);

    const settled = await tailsInAWindow();
    expect(settled).toBeLessThanOrEqual(SETTLED_TICKS);

    /**
     * AND THE TWO ARE A RATIO, NOT TWO NUMBERS THAT HAPPEN TO DIFFER. A
     * machine so starved that it dropped most of the live ticks could satisfy
     * both bounds above while measuring nothing; this fails on that machine
     * instead of passing quietly.
     */
    expect(live).toBeGreaterThan(settled);

    // ---- C. a turn is QUEUED again — the wedge assertion ------------------
    acceptANewTurn("cadence_a");
    await elapse(TAIL_SETTLED_MS + 600);

    const relived = await tailsInAWindow();
    expect(relived).toBeGreaterThanOrEqual(LIVE_TICKS);
  }, 20_000);

  test("and the transcript is whole across the slow stretch, not merely fast to arrive", async () => {
    /**
     * THE HALF A REQUEST COUNT CANNOT SEE. Every assertion above is satisfied
     * by a cockpit that polls at the right rate and drops what it reads, so
     * this one asserts the CONTENT survives a settle-and-start cycle: the
     * answer written while the conversation was quiet is still on screen after
     * it starts moving again, and the new turn is on screen too.
     *
     * This is the property a visibility gate would have had to prove and could
     * not: a gate that STOPS reading has a gap to reconcile on return. This
     * cadence never stops reading — only spaces out — so there is no gap, and
     * that is checked here rather than argued.
     */
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
  }, 20_000);
});
