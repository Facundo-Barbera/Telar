/**
 * THE PLUGINS PANE, DRAWN FROM THE SCHEMAS THE ENGINE PUBLISHES (P3).
 *
 * `bundled-machine-schemas.json` is exactly what the engine sends for LaTeX
 * and Data Science — an engine test fails if it drifts. Against it:
 *
 *   LaTeX          its distribution block, then a generated "Compiling" group
 *                  (Default engine, Install missing packages automatically)
 *   Data Science   a generated "Data science defaults" group (Default Python)
 *                  with its packages block inside it
 *   a write        the generated row writes the whole blob, keeping the rest
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import schemas from "../../../test-fixtures/bundled-machine-schemas.json";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { PluginsPage } = await import("./plugins-page");

const meta = (id: string, name: string, machineLabel: string) => ({
  id,
  api: 1,
  name,
  version: "1",
  toolPrefixes: [id === "data-science" ? "ds" : id],
  readTools: [],
  eventKinds: [],
  settings: [{ id: "defaults", scope: "machine", label: machineLabel }],
});

const PLUGINS = [
  { meta: meta("latex", "LaTeX", "Compiling"), state: "ready", machineSettingsSchema: schemas.latex },
  { meta: meta("data-science", "Data science", "Data science defaults"), state: "ready", machineSettingsSchema: schemas.dataScience },
];

let machine = {
  version: 1,
  entries: {
    latex: { enabled: true, settings: { engine: "xelatex" } },
    "data-science": { enabled: true, settings: { python: "/usr/bin/python3", packages: ["pandas"] } },
  },
};
let written: unknown[] = [];

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const realFetch = globalThis.fetch;
const realSetTimeout = window.setTimeout;

beforeEach(() => {
  written = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "PATCH" && url.includes("/api/plugins")) {
      const body = JSON.parse(String(init.body)) as { plugins: Record<string, unknown> };
      written.push(body.plugins);
      machine = { ...machine, entries: { ...machine.entries, ...(body.plugins as typeof machine.entries) } };
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

test("the bespoke blocks sit beside the generated groups, in the order they always had", async () => {
  const { host, done } = await mount();
  const text = host.textContent ?? "";
  // LaTeX: the distribution block, then its generated compile defaults.
  expect(text.indexOf("TeX distribution")).toBeLessThan(text.indexOf("Compiling"));
  expect(text).toContain("Default engine");
  expect(text).toContain("XeLaTeX");
  expect(text).toContain("Install missing packages automatically");
  // Data science: one group, the generated path field and the packages block.
  expect(text).toContain("Data science defaults");
  expect(text.indexOf("Default Python")).toBeLessThan(text.indexOf("Default packages"));
  expect((host.querySelector('[aria-label="Default Python"]') as HTMLInputElement).value).toBe("/usr/bin/python3");
  done();
});

test("a generated row writes the plugin's whole blob and keeps the Mac switch", async () => {
  const { host, done } = await mount();
  const toggle = host.querySelector('[aria-label="Install missing packages automatically"]') as HTMLElement;
  await act(async () => toggle.click());
  await flush();
  expect(written).toEqual([{ latex: { enabled: true, settings: { engine: "xelatex", autoInstallPackages: true } } }]);
  done();
});
