import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { PROJECT_PLUGINS_VERSION, type PluginStatus, type Project } from "@telar/engine-client";

mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

GlobalRegistrator.register({ url: "http://localhost/settings" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { ProjectPluginList } = await import("./project-plugins");
const { blockPatch, enablePatch } = await import("../sections");

const status = (id: string, name: string): PluginStatus =>
  ({ meta: { id, name, blurb: `${name} blurb`, settings: [] }, state: "ready" }) as never;
const LATEX = status("latex", "LaTeX");
const HELLO = status("hello", "Hello");

const project = (patch: Partial<Project & { hostId: string; hostName: string }> = {}, ...enabled: string[]) =>
  ({
    id: "project_abc",
    name: "Telar",
    root: "/tmp/telar",
    plugins: { version: PROJECT_PLUGINS_VERSION, entries: Object.fromEntries(enabled.map((id) => [id, { enabled: true }])) },
    ...patch,
  }) as unknown as Project;

let patches: unknown[] = [];
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const realFetch = globalThis.fetch;
const realSetTimeout = window.setTimeout;

beforeEach(() => {
  patches = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      patches.push({ url: String(input), body: JSON.parse(String(init.body)) });
      return json({ project: project() });
    }
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

async function mount(node: ReactNode) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  for (let i = 0; i < 10; i++) await act(async () => await Promise.resolve());
  return { host, done: () => act(() => root.unmount()) };
}

const visible = (element: Element | null) => Boolean(element) && !element!.closest("[hidden]");
const click = (element: Element | null) => act(async () => (element as HTMLElement).click());

test("one row per registered plugin, each switch showing the project's own state", async () => {
  const view = await mount(<ProjectPluginList project={project({}, "hello")} plugins={[LATEX, HELLO]} onChange={() => {}} />);
  const latex = view.host.querySelector('[aria-label="LaTeX for this project"]');
  const hello = view.host.querySelector('[aria-label="Hello for this project"]');
  expect(visible(latex) && visible(hello)).toBe(true);
  expect(latex!.getAttribute("aria-checked")).toBe("false");
  expect(hello!.getAttribute("aria-checked")).toBe("true");
  view.done();
});

test("choosing a registry-only plugin opens its page, which has nothing to configure", async () => {
  const view = await mount(<ProjectPluginList project={project({}, "hello")} plugins={[LATEX, HELLO]} onChange={() => {}} />);
  await click(view.host.querySelector('[aria-label="Open Hello"]'));
  const page = view.host.querySelector('[data-plugin-page="hello"]')!;
  expect(visible(page)).toBe(true);
  expect(visible(view.host.querySelector('[aria-label="Hello for this project"]'))).toBe(false);
  expect(page.textContent).toContain("Nothing to configure");
  expect(visible(page.querySelector('[aria-label="Hello enabled"]'))).toBe(true);
  view.done();
});

test("a plugin with its own pane gets that pane once it is on, and the generic one while off", () => {
  const on = renderToStaticMarkup(<ProjectPluginList project={project({}, "latex")} plugins={[LATEX]} onChange={() => {}} />);
  expect(on).toContain('aria-label="Enable LaTeX for this project"');
  expect(on).not.toContain('aria-label="LaTeX enabled"');
  const off = renderToStaticMarkup(<ProjectPluginList project={project()} plugins={[LATEX]} onChange={() => {}} />);
  expect(off).toContain('aria-label="LaTeX enabled"');
  expect(off).not.toContain('aria-label="Enable LaTeX for this project"');
});

test("the list switch sends the patch the plugin's own switch sends", async () => {
  const view = await mount(<ProjectPluginList project={project()} plugins={[LATEX, HELLO]} onChange={() => {}} />);
  await click(view.host.querySelector('[aria-label="LaTeX for this project"]'));
  await click(view.host.querySelector('[aria-label="Hello for this project"]'));
  expect(patches).toEqual([
    { url: "/api/projects/project_abc", body: blockPatch("latex", { enabled: true }) },
    { url: "/api/projects/project_abc", body: enablePatch("hello", true) },
  ]);
  view.done();
});

test("without a project, or on another Mac, the switches are inert and nothing opens", () => {
  const none = renderToStaticMarkup(<ProjectPluginList plugins={[LATEX]} />);
  expect(none).toContain("Select a project to turn LaTeX on for it.");
  expect(none).not.toContain('aria-label="Open LaTeX"');
  const far = renderToStaticMarkup(<ProjectPluginList project={project({ hostId: "host_mini", hostName: "mini" })} plugins={[LATEX]} />);
  expect(far).toContain("Registered on mini");
  expect(far).toContain("inert");
  expect(renderToStaticMarkup(<ProjectPluginList plugins={[]} />)).toContain("No plugins registered");
});

test("a plugin off for the whole Mac is inert in the list and on its page, and says where to turn it on", () => {
  const machine = { version: 1, entries: { latex: { enabled: false } } };
  const html = renderToStaticMarkup(<ProjectPluginList project={project({}, "latex")} plugins={[LATEX]} machine={machine} onChange={() => {}} />);
  expect(html.match(/LaTeX is off for every project on this Mac\./g)).toHaveLength(2);
  expect(html).toContain('href="/settings?section=plugins"');
  expect(html).not.toContain('aria-label="Enable LaTeX for this project"');
  expect(renderToStaticMarkup(<ProjectPluginList project={project({}, "latex")} plugins={[LATEX]} onChange={() => {}} />)).not.toContain("off for every project");
});
