/**
 * ONE VISIBILITY PREDICATE FOR THE SHELL AND THE BROWSER — issue #834.
 *
 * Inside the desktop shell `document.visibilityState` is pinned to "visible",
 * so every case here that runs under a scripted bridge leaves the document
 * saying "visible" throughout: a predicate that still read the document would
 * pass none of them. The fallback cases remove the bridge and drive the real
 * Page Visibility API instead, so the browser build is not quietly ungated.
 *
 * And the falsification #834 asks for, against the Usage page's real poll: the
 * request count drops while hidden AND does not drop while visible — the
 * second half is what proves the live path still runs.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { hostVisible, subscribeHostVisibility, useHostVisibility } from "./host-visibility";
import { useProcessMetrics } from "./desktop-metrics";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

type Bridge = Record<string, unknown>;
const host = window as unknown as { telarDesktop?: Bridge };
const unsubscribes: Array<() => void> = [];

afterEach(() => {
  // The last unsubscribe drops the store's bridge subscription, so the next
  // test starts from nothing.
  for (const off of unsubscribes.splice(0)) off();
  delete host.telarDesktop;
  setDocumentHidden(false);
});

/** A scripted shell: `answer` is what `get` resolves, `push` is an edge. */
function installShell(answer: boolean | Promise<boolean> = true) {
  const listeners = new Set<(visible: boolean) => void>();
  const visibility = {
    get: () => Promise.resolve(answer),
    onChange: (listener: (visible: boolean) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  host.telarDesktop = { ...host.telarDesktop, visibility };
  return {
    listeners,
    push: (visible: boolean) => {
      for (const listener of listeners) listener(visible);
    },
  };
}

function setDocumentHidden(hidden: boolean) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
  document.dispatchEvent(new Event("visibilitychange"));
}

function listen(): { heard: boolean[] } {
  const heard: boolean[] = [];
  unsubscribes.push(subscribeHostVisibility(() => heard.push(hostVisible())));
  return { heard };
}

const flush = () => act(async () => {});

describe("inside the shell", () => {
  test("follows the shell's pushes while the document keeps saying visible", async () => {
    const shell = installShell(true);
    const { heard } = listen();
    await flush();
    shell.push(false);
    expect(hostVisible()).toBe(false);
    expect(document.visibilityState).toBe("visible");
    shell.push(true);
    expect(heard).toEqual([false, true]);
  });

  test("a window that mounts while hidden learns it from the shell's answer", async () => {
    installShell(false);
    const { heard } = listen();
    await flush();
    expect(hostVisible()).toBe(false);
    expect(heard).toEqual([false]);
  });

  test("a push that lands while the answer is in flight wins over it", async () => {
    let answer!: (visible: boolean) => void;
    const shell = installShell(new Promise<boolean>((resolve) => (answer = resolve)));
    listen();
    shell.push(false);
    answer(true);
    await flush();
    expect(hostVisible()).toBe(false);
  });

  test("the bridge subscription is dropped with the last listener", async () => {
    const shell = installShell(true);
    listen();
    listen();
    expect(shell.listeners.size).toBe(1);
    for (const off of unsubscribes.splice(0)) off();
    expect(shell.listeners.size).toBe(0);
  });
});

describe("in a browser", () => {
  test("falls back to the Page Visibility API", () => {
    const { heard } = listen();
    setDocumentHidden(true);
    expect(hostVisible()).toBe(false);
    setDocumentHidden(false);
    expect(heard).toEqual([false, true]);
  });

  test("so does a shell packaged before the signal existed", () => {
    host.telarDesktop = { metrics: {} };
    listen();
    setDocumentHidden(true);
    expect(hostVisible()).toBe(false);
  });
});

describe("useHostVisibility", () => {
  test("re-renders on the shell's edges", async () => {
    const shell = installShell(true);
    const seen: boolean[] = [];
    function Probe() {
      seen.push(useHostVisibility());
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Probe />));
    await act(async () => shell.push(false));
    await act(async () => shell.push(true));
    await act(async () => root.unmount());
    expect(seen.at(-2)).toBe(false);
    expect(seen.at(-1)).toBe(true);
  });
});

describe("the Usage page's poll", () => {
  test("stops while the shell says hidden, and keeps running while it says visible", async () => {
    const shell = installShell(true);
    let reads = 0;
    host.telarDesktop!.metrics = {
      read: async () => {
        reads += 1;
        return { readAt: 0, windowMs: 0, totals: { cpuPercent: 0, memoryKb: 0, processes: 0 }, types: [], busiest: [] };
      },
    };
    // The interval is driven by hand: no real timer, and each tick is one we chose.
    const realSetInterval = window.setInterval;
    const realClearInterval = window.clearInterval;
    let tick: () => void = () => undefined;
    window.setInterval = ((fn: () => void) => {
      tick = fn;
      return 1;
    }) as typeof window.setInterval;
    window.clearInterval = (() => undefined) as typeof window.clearInterval;

    function Page() {
      useProcessMetrics(2_000);
      return null;
    }
    const root = createRoot(document.createElement("div"));
    try {
      await act(async () => root.render(<Page />));
      const ticks = async (n: number) => {
        for (let i = 0; i < n; i += 1) await act(async () => tick());
      };

      const mounted = reads;
      expect(mounted).toBe(1);
      await ticks(3);
      expect(reads).toBe(mounted + 3);

      await act(async () => shell.push(false));
      const hidden = reads;
      await ticks(3);
      expect(reads).toBe(hidden);

      // Back in front of somebody: one read now, then the poll resumes.
      await act(async () => shell.push(true));
      expect(reads).toBe(hidden + 1);
      await ticks(2);
      expect(reads).toBe(hidden + 3);
    } finally {
      await act(async () => root.unmount());
      window.setInterval = realSetInterval;
      window.clearInterval = realClearInterval;
    }
  });
});
