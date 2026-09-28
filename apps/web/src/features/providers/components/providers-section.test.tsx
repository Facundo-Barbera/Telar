import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

GlobalRegistrator.register({ url: "http://localhost/settings?section=providers" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { ProvidersSection } = await import("./providers-section");

const instance = (id: string, driver: string, extra: Record<string, unknown> = {}) => ({ id, driver, enabled: true, env: [], createdAt: 1, updatedAt: 1, ...extra });
const INSTANCES = [instance("claude", "claude"), instance("codex", "codex"), instance("claude_work", "claude", { displayName: "Day job" })];
const PROBES = [
  { instanceId: "claude", driver: "claude", status: "ready", installed: true, signIn: "signed-in", version: "2.1.0" },
  { instanceId: "codex", driver: "codex", status: "error", installed: false },
];

let saved: unknown[] = [];
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const realFetch = globalThis.fetch;
const realSetTimeout = window.setTimeout;

beforeEach(() => {
  saved = [];
  window.history.replaceState(null, "", "/settings?section=providers");
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/provider-instances") && init?.method && init.method !== "GET") {
      saved.push(JSON.parse(String(init.body)));
      return json({ providerInstance: INSTANCES[0] });
    }
    if (url.startsWith("/api/provider-instances")) return json({ providerInstances: INSTANCES, probes: PROBES });
    return json({});
  }) as typeof fetch;
  window.setTimeout = ((fn: () => void) => {
    queueMicrotask(fn);
    return 0;
  }) as unknown as typeof window.setTimeout;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  window.setTimeout = realSetTimeout;
  document.body.innerHTML = "";
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

async function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<ProvidersSection />));
  for (let i = 0; i < 20; i++) await act(async () => await Promise.resolve());
  return {
    host,
    shown: () => [...host.querySelectorAll<HTMLElement>("[data-detail-for]")].filter((detail) => !detail.hidden).map((detail) => detail.dataset.detailFor),
    done: () => act(() => root.unmount()),
  };
}

test("every login is listed with its status, and the first one's settings sit beside the list", async () => {
  const view = await mount();
  const labels = [...view.host.querySelectorAll('[role="option"]')].map((option) => option.textContent);
  expect(labels).toHaveLength(3);
  expect(labels.join("|")).toContain("Day job");
  expect(labels.join("|")).toContain("Not installed");
  expect(view.shown()).toHaveLength(1);
  expect(view.host.textContent).toContain("Add a login");
  view.done();
});

test("choosing a login shows its settings, and a deep link opens on it", async () => {
  const view = await mount();
  await act(async () => (view.host.querySelector('[data-master-item="claude_work"]') as HTMLElement).click());
  expect(view.shown()).toEqual(["claude_work"]);
  view.done();

  const linked = await mount();
  expect(linked.shown()).toEqual(["claude_work"]);
  linked.done();
});

test("the list switch saves the same enabled patch as before", async () => {
  const view = await mount();
  await act(async () => (view.host.querySelector('[aria-label="Enable Day job"]') as HTMLElement).click());
  for (let i = 0; i < 10; i++) await act(async () => await Promise.resolve());
  expect(saved).toEqual([{ id: "claude_work", enabled: false }]);
  view.done();
});
