import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { PluginStatus } from "@telar/engine-client";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { machinePaneShown, PluginsPage } = await import("./plugins-page");

const status = (id: string, state: PluginStatus["state"] = "ready"): PluginStatus =>
  ({ meta: { id, name: id, settings: [{ id: "defaults", scope: "machine", label: id }] }, state }) as never;

test("a plugin switched off for this Mac contributes no defaults group", () => {
  const machine = { version: 1, entries: { latex: { enabled: false } } };
  expect(machinePaneShown(status("latex"), machine)).toBe(false);
  expect(machinePaneShown(status("data-science"), machine)).toBe(true);
  expect(machinePaneShown(status("broken", "failed"), undefined)).toBe(false);
  expect(machinePaneShown(status("latex"), undefined)).toBe(true);
});

const meta = (id: string, name: string, settings: unknown[] = []) => ({ id, api: 1, name, version: "1", blurb: `${name} blurb`, toolPrefixes: [], readTools: [], eventKinds: [], settings });
const PLUGINS = [
  { meta: meta("latex", "LaTeX", [{ id: "defaults", scope: "machine", label: "Compiling" }]), state: "ready" },
  { meta: meta("hello", "Hello"), state: "ready" },
];

let machine: { version: number; entries: Record<string, unknown> } = { version: 1, entries: {} };
let patches: unknown[] = [];

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const realFetch = globalThis.fetch;
const realSetTimeout = window.setTimeout;

beforeEach(() => {
  patches = [];
  machine = { version: 1, entries: { latex: { enabled: false } } };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "PATCH" && url.includes("/api/plugins")) {
      const body = JSON.parse(String(init.body)) as { plugins: Record<string, unknown> };
      patches.push(body.plugins);
      machine = { ...machine, entries: { ...machine.entries, ...body.plugins } };
      return json({ machine });
    }
    if (url.includes("/api/plugins")) return json({ plugins: PLUGINS, machine });
    if (url.includes("/latex/toolchain")) return json({ toolchain: { texlive: [] } });
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
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const flush = async () => {
  for (let i = 0; i < 20; i++) await act(async () => await Promise.resolve());
};

async function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<PluginsPage />));
  await flush();
  return { host, done: () => act(() => root.unmount()) };
}

const visible = (element: Element | null) => Boolean(element) && !element!.closest("[hidden]");

test("the list has one row per registered plugin, with the Mac switch as it stands", async () => {
  const { host, done } = await mount();
  const latex = host.querySelector('[aria-label="LaTeX enabled on this Mac"]')!;
  const hello = host.querySelector('[aria-label="Hello enabled on this Mac"]')!;
  expect(visible(latex) && visible(hello)).toBe(true);
  expect(latex.getAttribute("aria-checked")).toBe("false");
  expect(hello.getAttribute("aria-checked")).toBe("true");
  expect(visible(host.querySelector('[aria-label="LaTeX on this Mac"]'))).toBe(false);
  expect(visible([...host.querySelectorAll("button")].find((button) => button.textContent === "Copy…")!)).toBe(true);
  done();
});

test("choosing a row opens that plugin's page, and back returns to the list", async () => {
  const { host, done } = await mount();
  await act(async () => (host.querySelector('[aria-label="Open Hello"]') as HTMLElement).click());
  expect(visible(host.querySelector('[aria-label="Hello on this Mac"]'))).toBe(true);
  expect(visible(host.querySelector('[aria-label="LaTeX enabled on this Mac"]'))).toBe(false);
  const page = host.querySelector('[data-plugin-page="hello"]')!;
  expect(page.textContent).toContain("Nothing to configure");
  await act(async () => ([...page.querySelectorAll("button")].find((button) => button.textContent === "Plugins") as HTMLElement).click());
  expect(visible(host.querySelector('[aria-label="LaTeX enabled on this Mac"]'))).toBe(true);
  done();
});

test("the switch sends the same Mac patch from the list and from the page", async () => {
  const { host, done } = await mount();
  await act(async () => (host.querySelector('[aria-label="LaTeX enabled on this Mac"]') as HTMLElement).click());
  await flush();
  await act(async () => (host.querySelector('[aria-label="Open LaTeX"]') as HTMLElement).click());
  await act(async () => (host.querySelector('[aria-label="LaTeX on this Mac"]') as HTMLElement).click());
  await flush();
  expect(patches).toEqual([{ latex: { enabled: true } }, { latex: { enabled: false } }]);
  done();
});
