/**
 * ADD AND REMOVE AN INSTALLED PLUGIN FROM SETTINGS ▸ PLUGINS.
 *
 *   add      a chosen folder is posted with the mode pressed; a refusal shows its reason
 *   remove   only installed plugins offer it, and only after a confirm
 */
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { PluginsPage } = await import("./plugins-page");

const meta = (id: string, name: string) => ({ id, api: 1, name, version: "1", toolPrefixes: [], readTools: [], eventKinds: [], settings: [] });

let plugins: unknown[] = [];
let calls: { method: string; url: string; body?: unknown }[] = [];
let refuse: string | undefined;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const realFetch = globalThis.fetch;
const realSetTimeout = window.setTimeout;
const realConfirm = window.confirm;

beforeEach(() => {
  calls = [];
  refuse = undefined;
  plugins = [
    { meta: meta("latex", "LaTeX"), state: "ready" },
    { meta: meta("echo", "Echo"), state: "ready", installed: { linked: true } },
  ];
  (window as unknown as { telarDesktop?: unknown }).telarDesktop = { dialog: { chooseDirectory: async () => ({ path: "/Users/me/echo-plugin" }) } };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (method === "POST" && url === "/api/plugins/installed") {
      if (refuse) return json({ error: { code: "invalid_request", message: refuse } }, 400);
      plugins = [...plugins, { meta: meta("other", "Other"), state: "ready", installed: { linked: false } }];
      return json({ plugin: plugins.at(-1) });
    }
    if (method === "DELETE") {
      plugins = plugins.filter((status) => (status as { meta: { id: string } }).meta.id !== "echo");
      return json({ removed: true });
    }
    if (url.includes("/api/plugins")) return json({ plugins, machine: { version: 1, entries: {} } });
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
  window.confirm = realConfirm;
  delete (window as unknown as { telarDesktop?: unknown }).telarDesktop;
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

const buttons = (host: HTMLElement, label: string) => [...host.querySelectorAll("button")].filter((candidate) => candidate.textContent === label);

test("only an installed plugin offers Remove", async () => {
  const { host, done } = await mount();
  expect(buttons(host, "Remove")).toHaveLength(1);
  done();
});

test("a chosen folder is installed with the mode pressed, and the list reloads", async () => {
  const { host, done } = await mount();
  await act(async () => buttons(host, "Link…")[0]!.click());
  await flush();
  expect(calls.find((call) => call.method === "POST")?.body).toEqual({ path: "/Users/me/echo-plugin", mode: "link" });
  expect(host.textContent).toContain("Other");
  done();
});

test("a refused folder shows the engine's reason", async () => {
  refuse = "plugin.json: missing";
  const { host, done } = await mount();
  await act(async () => buttons(host, "Copy…")[0]!.click());
  await flush();
  expect(host.textContent).toContain("plugin.json: missing");
  done();
});

test("Remove asks first, and a declined confirm removes nothing", async () => {
  const { host, done } = await mount();
  let asked = "";
  window.confirm = (message?: string) => {
    asked = message ?? "";
    return false;
  };
  await act(async () => buttons(host, "Remove")[0]!.click());
  await flush();
  expect(asked).toContain("your folder stays");
  expect(calls.some((call) => call.method === "DELETE")).toBe(false);

  window.confirm = () => true;
  await act(async () => buttons(host, "Remove")[0]!.click());
  await flush();
  expect(calls.find((call) => call.method === "DELETE")?.url).toBe("/api/plugins/installed/echo");
  expect(host.textContent).not.toContain("Echo");
  done();
});
