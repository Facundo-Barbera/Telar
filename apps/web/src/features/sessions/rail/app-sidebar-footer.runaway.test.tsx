/**
 * A RUNAWAY RENDERER, VISIBLE WITHOUT THE USAGE PAGE OPEN — issue #787.
 *
 * WHAT MAKES THIS NON-VACUOUS. "The indicator appeared" is satisfied by a
 * component that draws a flame unconditionally, and by one wired to a fixture
 * that never went near the watchdog. So every assertion below is on a VALUE
 * that could only have come from the notice — the pid, the load, and which of
 * the two states the shell reported — and every case has its opposite run
 * beside it, including the two that must draw NOTHING:
 *
 *   - a poll that ran and found nothing (`renderers: []`), which is what takes
 *     the indicator back down, and
 *   - no shell at all, which is a browser tab and must not be told its Mac is
 *     on fire.
 *
 * The decision itself is `service-worker-watchdog.test.js`'s, and that it
 * survives a real `app.getAppMetrics()` is `process-metrics.electron-test.js`'s.
 * This file is only the last hop.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { RunawayNotice } from "@/lib/desktop-metrics";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

const { RunawayIndicator } = await import("./app-sidebar-footer");

// ── the scripted shell ────────────────────────────────────────────────────
let listeners: Set<(notice: RunawayNotice) => void>;
let seed: RunawayNotice | undefined;
let rejectSeed: boolean;

const seatBridge = (present = true) => {
  const window = (globalThis as { window?: { telarDesktop?: unknown } }).window!;
  if (!present) {
    delete window.telarDesktop;
    return;
  }
  window.telarDesktop = {
    metrics: {
      read: async () => {
        throw new Error("not used here");
      },
      runaway: async () => {
        if (rejectSeed) throw new Error("the shell did not answer");
        return seed;
      },
      onRunaway: (listener: (notice: RunawayNotice) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
};

beforeEach(() => {
  listeners = new Set();
  seed = undefined;
  rejectSeed = false;
  seatBridge();
});

/** Mount, let the seed settle, and answer the markup. */
async function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<RunawayIndicator />);
  });
  return {
    html: () => host.innerHTML,
    /** One poll's worth of the shell speaking. */
    push: async (notice: RunawayNotice) => {
      await act(async () => {
        for (const listener of listeners) listener(notice);
      });
    },
    unmount: () => act(() => root.unmount()),
  };
}

const hot = (over: Partial<RunawayNotice["renderers"][number]> = {}): RunawayNotice => ({
  at: 1_700_000_000_000,
  renderers: [{ pid: 318, percent: 96, polls: 2, killed: false, origins: [], ...over }],
});

describe("the runaway indicator in the sidebar footer", () => {
  test("says nothing until the shell says something", async () => {
    // A cockpit that has just mounted knows nothing, and "nothing said yet" is
    // not "nothing is wrong". Neither state draws a warning, but only one of
    // them could be corrected by the next poll.
    const view = await mount();
    expect(view.html()).toBe("");
    view.unmount();
  });

  test("draws the renderer the shell will NOT kill, with its load and its pid", async () => {
    const view = await mount();
    await view.push(hot());
    const html = view.html();
    // The load is the notice's, not a constant: 96 is the incident's number and
    // is nowhere in the component.
    expect(html).toContain("96%");
    expect(html).toContain("no page open");
    expect(html).toContain('href="/usage"');
    view.unmount();
  });

  test("and says so in the past tense when the shell did kill it", async () => {
    // Two different pieces of news. One is over; the other is still burning a
    // core and will keep doing so, because the watchdog refuses to kill what it
    // cannot name. A single sentence for both would mislead about one of them.
    const view = await mount();
    await view.push(hot({ killed: true, percent: 132, origins: ["https://github.com"] }));
    const html = view.html();
    expect(html).toContain("Stopped a runaway renderer");
    expect(html).toContain("132%");
    expect(html).not.toContain("no page open");
    view.unmount();
  });

  test("the still-running one leads when the poll carries both", async () => {
    const view = await mount();
    await view.push({
      at: 1,
      renderers: [
        { pid: 1, percent: 400, polls: 2, killed: true, origins: [] },
        { pid: 2, percent: 90, polls: 9, killed: false, origins: [] },
      ],
    });
    // 400% is hotter, and it is already dealt with. The one worth a person's
    // attention is the one that is still going.
    expect(view.html()).toContain("90%");
    expect(view.html()).toContain("no page open");
    view.unmount();
  });

  test("A POLL THAT FOUND NOTHING TAKES IT BACK DOWN", async () => {
    // The negative direction on the same path. Without it, every assertion
    // above is satisfied by a component that lights once and never clears —
    // which would leave the cockpit warning about a process that is gone.
    const view = await mount();
    await view.push(hot());
    expect(view.html()).not.toBe("");
    await view.push({ at: 2, renderers: [] });
    expect(view.html()).toBe("");
    view.unmount();
  });

  test("a window that mounted between polls is seeded with the last thing said", async () => {
    // Thirty seconds is a long time to show nothing while a core burns, and a
    // reload, a second window or a renderer that crashed and came back all land
    // in that gap.
    seed = hot({ percent: 88 });
    const view = await mount();
    expect(view.html()).toContain("88%");
    view.unmount();
  });

  test("a push that beat the seed home is not overwritten by it", async () => {
    // The seed is the older reading by construction. Letting it win would put a
    // stale figure — or a stale all-clear — in front of somebody.
    seed = hot({ percent: 88 });
    const view = await mount();
    await view.push(hot({ percent: 91 }));
    expect(view.html()).toContain("91%");
    expect(view.html()).not.toContain("88%");
    view.unmount();
  });

  test("a browser tab with no shell draws nothing and asks for nothing", async () => {
    // It cannot tell "no desktop shell" from "the shell is wedged", and telling
    // somebody on a phone that their Mac is on fire is the worse guess — the
    // same call `useProcessMetrics` already makes about a failed first read.
    seatBridge(false);
    const view = await mount();
    expect(view.html()).toBe("");
    view.unmount();
  });

  test("a shell that cannot answer the seed still hears the next poll", async () => {
    rejectSeed = true;
    const view = await mount();
    expect(view.html()).toBe("");
    await view.push(hot({ percent: 99 }));
    expect(view.html()).toContain("99%");
    view.unmount();
  });
});
