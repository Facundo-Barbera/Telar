/**
 * THE INSTRUMENT, FALSIFIED — #490.
 *
 * WHY THIS FILE EXISTS BESIDE `perf-marks.test.ts`. That file tests the ring's
 * BOOKKEEPING: which addresses are measured, that a phase nobody navigated to
 * is not invented, that the ring hands out copies, that the reader is fitted.
 * Every one of its duration assertions is `typeof timing?.commit === "number"`
 * — and a clock frozen at zero satisfies all six. So it establishes that the
 * instrument RECORDS, and nothing at all about whether what it records is a
 * measurement.
 *
 * #490's audit is to be priced against this instrument, and a number from an
 * instrument nobody has tried to break is a number about the instrument. So
 * this file does the one thing that separates the two: it MAKES THE MEASURED
 * THING SLOWER ON PURPOSE AND CHECKS THE NUMBER MOVES.
 *
 * WHAT IS MADE SLOW. `/bootstrap` — the single read the whole opening waits on
 * (`session-cockpit.tsx`'s `hydrate`) — is delayed by a known number of
 * milliseconds in the fetch fixture. Nothing else changes. If `transcript` does
 * not move by roughly that amount, the phase is not measuring the read it
 * claims to, and every figure attributed to it is worthless.
 *
 * TWO POINTS, NEVER ONE. A single `expect(transcript).toBeGreaterThan(0)` is
 * satisfied by a clock that returns any constant, and by one that measures
 * something else entirely that happens to take time. Each claim here is a PAIR
 * — a slow opening and a fast one — so the assertion is about the DIFFERENCE,
 * which a constant cannot produce. The pair is run in both orders (slow-first
 * and fast-first, on their own mounts) because a warm module singleton would
 * otherwise let ordering masquerade as measurement.
 *
 * IN PROCESS, AND NOTHING SURVIVES THE TURN. Happy DOM and React's own `act`,
 * the same harness `session-cockpit.switch.test.tsx` already uses. No browser,
 * no server, no daemon: a latency measurement is exactly the task that tempts
 * one, and a headless browser left running is a worse bug than an unmeasured
 * instrument.
 *
 * THE REAL COCKPIT, AND A REAL PRESS. The component under the clock is the one
 * the app renders, and the clock is started by clicking an anchor so that
 * `installNavigationMarks`' capture-phase listener takes the stamp — the same
 * path a press on a rail row takes. Calling `startNavigation` from the test and
 * then checking `startNavigation` happened would measure nothing.
 *
 * TWO OF THE FOUR ASSERTIONS BELOW PIN DEFECTS RATHER THAN GUARANTEES — see
 * `docs/investigations/490-instrument-falsification-2026-09-20.md`. They are
 * written to FAIL when the defect is fixed, and the comment on each says what
 * to replace it with. A characterisation test that does not say it is one is
 * how a bug becomes a requirement.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Session, Turn } from "@telar/engine-client";

GlobalRegistrator.register({ url: "http://localhost/projects/project_1/sessions/falsify_a" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// The transcript's top-edge watcher. Happy DOM has none, and this file does not
// exercise backward paging — but `ConversationTopEdge` constructs one on every
// mount, so its absence is a throw rather than a skipped feature.
(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
  observe() {}
  disconnect() {}
  unobserve() {}
};

let pathname = "/projects/project_1/sessions/falsify_a";
/**
 * RE-REGISTERED BEFORE EVERY TEST, not once at module scope.
 *
 * `mock.module` is a PROCESS-wide registration and the last writer wins. A
 * dozen files in this suite mock `next/navigation` with a `pathname` of their
 * own, so a registration made when this file is loaded can be replaced before
 * its tests run — and then `usePathname()` hands the cockpit somebody else's
 * address, the phases are marked against it, and every timing this file looks
 * for is simply absent. Measured: green alone, three red in the full suite,
 * with `transcript` undefined rather than wrong.
 */
const mockNavigation = () =>
  mock.module("next/navigation", () => ({
    useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
    usePathname: () => pathname,
    useSearchParams: () => new URLSearchParams(),
  }));
mockNavigation();
/**
 * THE SHELL IS NOT MOUNTED HERE, AND THE CLOCK IS STARTED THE WAY A READER
 * STARTS IT — by pressing a link.
 *
 * The first cut of this file mounted `<AppShell>` to get the production effect
 * order. It cost `app-shell.solo.test.tsx` four of its six cases, and the
 * collision is not fixable by being careful: that file's whole subject is
 * whether the shell reaches for the rail module, it counts the reaches inside
 * a `mock.module` factory, and `mock.module` is registered per PROCESS. Mount
 * the shell on a rail-drawing route from a second file and the count is wrong
 * — stub the module and the count never runs at all. Measured both ways:
 * green apart, four red together.
 *
 * SO THE CLOCK IS STARTED AS `from: "click"` — the population a person is
 * actually in when they say switching is slow — by calling the same entry point
 * the capture-phase listener calls, with the same argument.
 *
 * THE LISTENER ITSELF CANNOT BE EXERCISED FROM HERE, and that is a third thing
 * worth recording about the instrument: `installNavigationMarks` latches on a
 * module-level `listening` flag that is per PROCESS, not per document. It binds
 * to whatever `document` existed at the first call anywhere in the run —
 * `perf-marks.test.ts` spends it inside a Happy DOM it then UNREGISTERS — so by
 * the time this file runs, the one listener in the process is attached to a
 * document that no longer exists and no click here can reach it. Harmless in
 * the app, which has one document for the life of the tab; fatal to any test
 * that is not the first to call it. Measured: real anchor clicks start the
 * clock when this file runs alone and silently do nothing in the full suite.
 *
 * WHAT IS LOST WITH THE SHELL, and where it went: the `from: "route"` cold
 * load. Its own defect is pinned by the last test below, against the exact two
 * calls `app-shell.tsx:116-119` makes.
 */

const { forgetInboxPolicies, readInboxPolicy } = await import("@/lib/inbox-policy");
const { SessionCockpit } = await import("@/components/session-cockpit");
const { SidebarProvider } = await import("@/components/ui/sidebar");
const { installNavigationMarks, markNavigation, navigationTimings, startNavigation } = await import("./perf-marks");

/**
 * HOW MUCH LATER `/bootstrap` ANSWERS IN A "SLOW" OPENING.
 *
 * Large enough that it cannot be confused with the harness's own jitter on a
 * loaded machine, small enough that four openings stay well inside the
 * workspace's 20 s per-test ceiling.
 */
const DELAY_MS = 300;

const STARTED = 1_700_000_000_000;

const turn = (id: string): Turn =>
  ({
    runId: `run_${id}`,
    sessionId: id,
    sequence: 1,
    input: `ask ${id}`,
    state: "completed",
    acceptedAt: STARTED,
    updatedAt: STARTED,
    resultText: `answer from ${id}`,
  }) as Turn;

/** Enough of a session for the cockpit to draw one; everything optional left out. */
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

/** The knob this whole file turns. Read by the fixture on every `/bootstrap`. */
let bootstrapDelayMs = 0;
const realFetch = globalThis.fetch;

function wire() {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    const id = /sessions\/([^/?]+)/.exec(url)?.[1] ?? "";
    if (url.includes("/bootstrap")) {
      // THE ONE INJECTED COST. Every other route answers instantly, so a number
      // that moves can only have moved because of this.
      if (bootstrapDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, bootstrapDelayMs));
      return Response.json({ session: record(id), turns: [turn(id)], items: [], tasks: [], requests: [], cursor: 1, events: [], subscriptions: [] });
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
  mockNavigation();
  wire();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

/**
 * EVERY PIECE OF PROCESS-WIDE STATE A MOUNT HERE WARMS, PUT BACK.
 *
 * Mounting the real cockpit is not a local act. `lib/inbox-policy.ts` keeps a
 * `Map` keyed by host at module scope with a 30 s TTL (`:38`, `:44`), and the
 * cockpit's `useInboxPolicy()` fills the `"local"` entry from this file's stub
 * answer to `/api/inbox`. `inbox-policy.test.ts` then asserts that nine callers
 * make ONE request — and is served zero, because the entry is already warm.
 *
 * THAT FAILURE IS A FLAKE, WHICH IS WHY IT REACHED CI AND NOT THE LOCAL RUN.
 * It needs the two files to land within thirty seconds of each other in one
 * process, so file order and machine speed decide it: green here, red on the
 * shared runner. A green local suite is not evidence about this class of bug —
 * see the test at the end of this file, which is.
 *
 * THE THIRD INSTANCE OF ONE SHAPE in this file alone: `mock.module` is
 * per-process, `installNavigationMarks` latches per-process, and a module-level
 * cache is per-process. Anything a mounted component touches above its own
 * tree belongs in here.
 */
function releaseProcessWideState(): void {
  forgetInboxPolicies();
}

afterEach(async () => {
  globalThis.fetch = realFetch;
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  releaseProcessWideState();
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

/**
 * Open one conversation and hand back what the instrument recorded about it.
 *
 * THE SETTLE LOOP IS BOUNDED BY AN OBSERVATION, not by a sleep: the opening is
 * a promise chain behind a queue behind a deferred task, and a fixed wait long
 * enough for a loaded CI Mac is also long enough to hide a phase that never
 * arrives. It stops as soon as the transcript phase lands, and otherwise runs
 * out — which is itself one of the findings below.
 */
async function open(sessionId: string, delayMs: number) {
  bootstrapDelayMs = delayMs;
  const href = `/projects/project_1/sessions/${sessionId}`;
  /**
   * THE PRESS. One line, and it is the line the capture-phase listener runs —
   * `startNavigation(pathname, "click")`, with the pathname it takes off the
   * anchor. See the note at the top for why the listener cannot be driven with
   * a real click from a file that is not the first in the process to install it.
   */
  installNavigationMarks();
  startNavigation(href, "click");
  pathname = href;
  await act(async () => {
    root!.render(
      <SidebarProvider>
        <SessionCockpit projectId="project_1" sessionId={sessionId} projectName="exoplanets" />
      </SidebarProvider>,
    );
  });
  for (let pass = 0; pass < 60; pass += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
    const seen = navigationTimings().filter((timing) => timing.href === pathname).at(-1);
    if (seen?.transcript !== undefined) break;
  }
  // Two more turns of the loop after the transcript lands, so a phase that
  // arrives one commit later is not read as missing.
  for (let pass = 0; pass < 3; pass += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
  }
  return navigationTimings().filter((timing) => timing.href === pathname).at(-1);
}

describe("the navigation clock, made slow on purpose", () => {
  test("`transcript` moves by what was added to the read it waits on", async () => {
    /**
     * THE POSITIVE CONTROL FOR EVERY FIGURE #490's AUDIT ATTRIBUTES TO THIS
     * INSTRUMENT. `/bootstrap` is delayed by a known amount and nothing else is
     * touched; the phase that claims to measure "the first paint of the
     * conversation's own rows" has to move with it.
     */
    const slow = await open("falsify_slow_a", DELAY_MS);
    const fast = await open("falsify_fast_a", 0);

    expect(slow?.transcript).toBeDefined();
    expect(fast?.transcript).toBeDefined();
    // The injected delay is a FLOOR on the slow opening: the read cannot answer
    // before it.
    expect(slow!.transcript!).toBeGreaterThanOrEqual(DELAY_MS * 0.75);
    /**
     * AND THE DIFFERENCE IS THE ASSERTION THAT A CONSTANT CANNOT PASS. Half the
     * injected delay rather than all of it, because the harness's own jitter is
     * added to BOTH readings and a loaded machine moves the fast one too — the
     * claim being made is "it tracks", not "it tracks to the millisecond".
     */
    expect(slow!.transcript! - fast!.transcript!).toBeGreaterThanOrEqual(DELAY_MS * 0.5);
  });

  test("...in the other order too, so it is measurement and not warm-up", async () => {
    /**
     * THE SAME PAIR, FAST FIRST. `perf-marks` keeps a module-level ring and the
     * cockpit keeps module-level connections, both of which outlive a test the
     * way they outlive a switch — so a first opening is genuinely colder than a
     * second, and a one-order test could report that warmth as the delay.
     */
    const fast = await open("falsify_fast_b", 0);
    const slow = await open("falsify_slow_b", DELAY_MS);

    expect(slow!.transcript!).toBeGreaterThanOrEqual(DELAY_MS * 0.75);
    expect(slow!.transcript! - fast!.transcript!).toBeGreaterThanOrEqual(DELAY_MS * 0.5);
  });

  test("DEFECT, PINNED: `commit` is zero for a route-started opening, however slow it was", () => {
    /**
     * NOT A GUARANTEE — A LIMIT, recorded so it cannot be cited as a measurement.
     *
     * THE TWO CALLS BELOW ARE `app-shell.tsx:116-119`, in its order. The shell
     * runs them in ONE effect body, in one tick, so for every navigation it
     * starts — a cold load, a redirect, the back button, every `from: "route"`
     * opening — `commit` is the distance from a stamp to itself. No delay
     * anywhere in the app can move it, which is why it is reproduced here
     * rather than measured through a mount: a mounted 300 ms opening reports
     * exactly the same 0, and reporting 0 from a slow render would suggest the
     * render is what made it 0.
     *
     * The shell's own comment argues the cockpit's `commit` is the one recorded,
     * because child effects run before parent ones. That ordering is real and it
     * has the opposite consequence: the child's mark runs while the ring's
     * `current` is still undefined or still the PREVIOUS address, so the
     * `current.href !== href` guard drops it and the parent's zero lands.
     *
     * A CLICK-STARTED OPENING IS A DIFFERENT POPULATION and is not covered by
     * this — there the stamp is taken at press time and `commit` is a real span,
     * which the tests above measure. The file is right that the two must never
     * be averaged; this is the arithmetic reason.
     *
     * WHEN THIS IS FIXED — by marking commit from somewhere that is not the same
     * tick as the start — this test will fail. Replace it with the pair-wise
     * assertion the two tests above use.
     */
    const href = "/projects/project_1/sessions/falsify_route_commit";
    startNavigation(href, "route");
    markNavigation("commit", href);
    const timing = navigationTimings().filter((entry) => entry.href === href).at(-1);
    expect(timing?.from).toBe("route");
    expect(timing?.commit).toBe(0);
    markNavigation("idle", href);
  });

  test("DEFECT, PINNED: on a switch, `idle` is stamped BEFORE the transcript it claims to follow", async () => {
    /**
     * THE PHASE IS WRONG — NOT MISSING — FOR EXACTLY THE POPULATION #490 IS
     * ABOUT, and wrong in the flattering direction.
     *
     * `loading` is a ONE-WAY LATCH: `useState(Boolean(routeSessionId))` at
     * `session-cockpit.tsx:1515`, and the only writes are `setLoading(false)`
     * (`:2848`, `:2863`). Nothing sets it true again, and the cockpit does not
     * remount between conversations — that is #497's whole design.
     *
     * So the FIRST opening on a mounted cockpit is honest: `loading` goes
     * true→false when the read lands, and `idle` is stamped with it. On every
     * switch after that, the effect keyed `[loading, pathname]` re-runs because
     * the ADDRESS changed while `loading` is already false — in the commit that
     * switches, before `/bootstrap` has even been asked. `idle` is therefore
     * stamped a few milliseconds into an opening that is still hundreds of
     * milliseconds from painting, and the ring records a conversation that
     * settled before its own transcript arrived.
     *
     * THE ASSERTION IS THE CONTRADICTION ITSELF — `idle` earlier than
     * `transcript` — rather than a threshold, because the contradiction cannot
     * be produced by a slow machine, a fast machine, or any amount of jitter.
     * "Everything else the screen wanted before it settled" cannot complete
     * before the rows it was waiting for.
     *
     * WHAT IT COSTS #490: "transcript → idle", one of the three spans this
     * instrument's header promises, is negative on every switch. The owner's
     * complaint is "switching between them is instant, not 2 minutes" — and the
     * instrument reports switching as the fastest thing the app does.
     *
     * THE `from: "route"` VARIANT IS WORSE AND IS NOT PINNED HERE. Mounted under
     * `<AppShell>`, where the shell rather than a press starts the clock, the
     * same latch drops `idle` on the `current.href !== href` guard and the phase
     * is absent altogether: measured 41.3 ms / 313.3 ms on first openings and
     * nothing at all on the three switches that followed. That measurement is in
     * the doc; it is not a test here because mounting the shell breaks
     * `app-shell.solo.test.tsx` (see the note at the top of this file).
     *
     * WHEN THIS IS FIXED — by resetting `loading` on a switch, or by stamping
     * idle off the read settling rather than off a latch — this will fail.
     * Replace it with the same slow-versus-fast pair the first two tests use,
     * which is the assertion `idle` deserves once it means anything.
     */
    const first = await open("falsify_idle_first", DELAY_MS);
    const second = await open("falsify_idle_second", DELAY_MS);

    // The first opening on this cockpit is honest, and tracks the injected
    // delay — so the phase is not broken in itself, only unreachable after this.
    expect(first?.idle).toBeGreaterThanOrEqual(DELAY_MS * 0.75);

    // The switch took just as long: the transcript proves it.
    expect(second?.transcript).toBeGreaterThanOrEqual(DELAY_MS * 0.75);
    // ...and `idle` says it was over before that. The impossible ordering is
    // the whole finding.
    expect(second?.idle).toBeDefined();
    expect(second!.idle!).toBeLessThan(second!.transcript!);
  });

  test("and this file leaves no warm cache behind for the next one", async () => {
    /**
     * THE REGRESSION TEST FOR THE FLAKE THIS FILE CAUSED, written so that it
     * cannot pass for the wrong reason: it checks BOTH halves.
     *
     * First that the leak is real — right after an opening, a fresh
     * `readInboxPolicy("local", …)` is served from cache and the fetcher is
     * never called. An assertion that only checked the cleared state would pass
     * just as well against a cockpit that never touched the cache at all, and
     * would then go on passing after somebody removed the clear.
     *
     * Then that `releaseProcessWideState` — which `afterEach` runs — actually
     * puts it back, which is the property `inbox-policy.test.ts` depends on and
     * has no way to defend for itself.
     */
    await open("falsify_leak", 0);

    let calls = 0;
    const count = async () => {
      calls += 1;
      return { autoSettleAfterHours: 20 } as Awaited<ReturnType<typeof readInboxPolicy>>;
    };

    // The leak, demonstrated: warm, so nobody asks.
    await readInboxPolicy("local", count);
    expect(calls).toBe(0);

    // ...and the cleanup, demonstrated: cold again, so the next file's first
    // caller does the asking its own test expects it to.
    releaseProcessWideState();
    await readInboxPolicy("local", count);
    expect(calls).toBe(1);
  });
});
