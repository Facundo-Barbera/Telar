import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { EngineRestartNotice } from "@/platform/desktop/engine-restart";

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

const { EngineRestartIndicator } = await import("./app-sidebar-footer");

let listeners: Set<(notice: EngineRestartNotice) => void>;
let seed: EngineRestartNotice | null;

const seatBridge = (present = true) => {
  const window = (globalThis as { window?: { telarDesktop?: unknown } }).window!;
  if (!present) {
    delete window.telarDesktop;
    return;
  }
  window.telarDesktop = {
    engine: {
      lastRestart: async () => seed,
      onRestart: (listener: (notice: EngineRestartNotice) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
};

beforeEach(() => {
  listeners = new Set();
  seed = null;
  seatBridge();
});

async function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<EngineRestartIndicator />);
  });
  return {
    host,
    html: () => host.innerHTML,
    push: async (notice: EngineRestartNotice) => {
      await act(async () => {
        for (const listener of listeners) listener(notice);
      });
    },
    unmount: () => act(() => root.unmount()),
  };
}

describe("the engine restart indicator in the sidebar footer", () => {
  test("draws nothing until the engine has stopped", async () => {
    const view = await mount();
    expect(view.html()).toBe("");
    view.unmount();
  });

  test("names why the engine stopped and that it was restarted", async () => {
    const view = await mount();
    await view.push({ at: 1_700_000_000_000, reason: "uncaught TypeError: x is not a function", restarted: true });
    expect(view.html()).toContain("The engine stopped: uncaught TypeError: x is not a function; restarted at");
    view.unmount();
  });

  test("says so when the desktop gave up restarting it", async () => {
    seed = { at: 1, reason: "exit code 1", restarted: false };
    const view = await mount();
    expect(view.html()).toContain("it kept stopping, so it was not restarted");
    view.unmount();
  });

  test("a click dismisses it until the engine stops again", async () => {
    const view = await mount();
    await view.push({ at: 1, reason: "exit code 1", restarted: true });
    await act(async () => {
      view.host.querySelector("button")!.click();
    });
    expect(view.html()).toBe("");
    await view.push({ at: 2, reason: "killed by SIGKILL", restarted: true });
    expect(view.html()).toContain("killed by SIGKILL");
    view.unmount();
  });

  test("a browser tab with no desktop draws nothing", async () => {
    seatBridge(false);
    const view = await mount();
    expect(view.html()).toBe("");
    view.unmount();
  });
});
