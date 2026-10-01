import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { StoreBridge, StoreStatus } from "../desktop-store";
import { StoreSection } from "./store-section";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

afterEach(() => {
  delete (window as { telarDesktop?: unknown }).telarDesktop;
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

async function mount(status: StoreStatus) {
  const store: StoreBridge = { status: async () => status, removeOld: async () => ({ ok: true }), keepOld: async () => ({ ok: true }) };
  (window as { telarDesktop?: unknown }).telarDesktop = { store };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<StoreSection />);
    await settle();
  });
  return {
    host,
    labels: () => [...host.querySelectorAll("button")].map((button) => button.textContent?.trim()),
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

test("the store can be copied but not moved", async () => {
  const view = await mount({ path: "/Users/me/Library/Application Support/Telar/engine", defaultPath: "/x", pinnedByEnvironment: false });
  expect(view.labels()).toContain("Copy…");
  expect(view.labels()).not.toContain("Move…");
  expect(view.host.textContent).toContain("/Users/me/Library/Application Support/Telar/engine");
  view.unmount();
});

test("on a drive, the location is one line and the unplug caveat is behind its ⓘ", async () => {
  const view = await mount({ path: "/Volumes/Taller/telar", defaultPath: "/x", pinnedByEnvironment: false, volume: { mount: "/Volumes/Taller", label: "Taller" } });
  expect(view.host.textContent).toContain("Taller · /Volumes/Taller/telar");
  expect(view.host.textContent).not.toContain("Eject before unplugging");
  expect(view.host.querySelector("[data-info]")?.getAttribute("data-info")).toContain("Eject before unplugging");
  view.unmount();
});
