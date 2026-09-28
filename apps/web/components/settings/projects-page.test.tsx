// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { SETTINGS_SEARCH_INDEX } from "./settings-registry";
import { searchSettings } from "@/lib/settings-search";
import { projectSettingsHref } from "@/lib/project-settings-link";
import { enablePatch } from "@/lib/plugins/sections";
import { isTelarIcon, TELAR_ICONS, type ProviderModel } from "@telar/engine-client";
import type { ModelChoice } from "@/lib/models";
import { modelOptionsOf } from "@/components/composer-controls";
import type { ScopedProject } from "./projects-page";

const navigation = await import("next/navigation");
mock.module("next/navigation", () => ({
  ...navigation,
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
}));

const { ProjectConversationRows, ProjectIdentityRows, ProjectModelOptionsRow, ProjectPluginPanes, ProjectPluginRows, ProjectsPage } = await import("./projects-page");

GlobalRegistrator.register({ url: "http://localhost/settings" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function project(patch: Partial<ScopedProject> = {}): ScopedProject {
  return {
    id: "project_abc",
    environmentId: "env_abc",
    name: "Telar",
    root: "/Users/someone/code/telar",
    createdAt: 1,
    updatedAt: 2,
    ...patch,
  } as ScopedProject;
}

const LATEX = { meta: { id: "latex", name: "LaTeX", settings: [] }, state: "ready" } as never;

let local: ScopedProject[] = [];
let remote: ScopedProject[] = [];
let hosts: { id: string; name: string }[] = [];
let calls: { method: string; url: string; body?: Record<string, unknown> }[] = [];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const realFetch = globalThis.fetch;
const realSetTimeout = window.setTimeout;

beforeEach(() => {
  local = [project()];
  remote = [];
  hosts = [];
  calls = [];
  window.history.replaceState(null, "", "/settings");
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, ...(body ? { body } : {}) });
    if (method === "PATCH" && url.startsWith("/api/projects/")) {
      const found = local.find((entry) => url.endsWith(entry.id))!;
      return json({ project: { ...found, ...body, ...(body.name ? { name: `${body.name} (kept)` } : {}) } });
    }
    if (url === "/api/hosts") return json({ hosts });
    if (url === "/api/projects") return json({ projects: local });
    if (url === "/api/hosts/host_mini/projects") return json({ projects: remote });
    if (url === "/api/health") return json({ plugins: [LATEX] });
    return json({ error: { code: "not_found", message: "no" } }, 404);
  }) as typeof fetch;
  window.setTimeout = ((fn: () => void, ms?: number) => {
    if (ms) return realSetTimeout(fn, ms);
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

async function mount(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  await flush();
  return {
    host,
    button: (label: string) => [...document.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label || candidate.getAttribute("aria-label") === label),
    trigger: () => host.querySelector<HTMLElement>('[aria-label="Project these settings are about"]')!,
    scope: () => host.querySelector('[aria-label="Project these settings are about"] [data-slot="select-value"]')?.textContent,
    done: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

const press = async (element: Element | undefined) => {
  if (!element) throw new Error("nothing to press");
  await act(async () => {
    element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    (element as HTMLElement).click();
  });
  await flush();
};

const options = () => [...document.querySelectorAll('[role="option"]')].map((option) => option.textContent?.trim());
const option = (label: string) => [...document.querySelectorAll('[role="option"]')].find((candidate) => candidate.textContent?.trim() === label);

async function rename(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  await flush();
}

function writerSpy() {
  const saved: [string, unknown][] = [];
  return { saved, writer: { save: (field: string, patch: unknown) => void saved.push([field, patch]) } };
}

describe("static rows", () => {
  test("at All projects every per-project row is still drawn, and says which choice would answer it", () => {
    const html = renderToStaticMarkup(
      <>
        <ProjectIdentityRows />
        <ProjectConversationRows envMode="local" />
      </>,
    );
    expect(html).toContain("Name");
    expect(html).toContain("Icon");
    expect(html).toContain("Default model");
    expect(html).toContain("Where new conversations start");
    expect(html).toContain("Select a project to rename it.");
    expect(html).toContain("Select a project to mark it.");
    expect(html).toContain("Select a project to set the model its conversations open on.");
    expect(html).toContain("Select a project to say where its conversations start.");
  });

  test("an inert row's control is rendered and taken out of reach, never removed", () => {
    const html = renderToStaticMarkup(<ProjectIdentityRows />);
    expect(html).toContain("inert");
    expect(html).toContain("opacity-50");
  });

  test("naming a project binds the rows to it and takes the inert reason off", () => {
    const html = renderToStaticMarkup(<ProjectIdentityRows project={project()} />);
    expect(html).toContain("Telar");
    expect(html).toContain("/Users/someone/code/telar");
    expect(html).not.toContain("Select a project to rename it.");
    expect(html).not.toContain("inert");
    expect(html).toContain('aria-label="Project name"');
    expect(html).toContain('aria-label="Project icon"');
  });

  test("a project on another Mac keeps every identity row read-only, and says whose", () => {
    const html = renderToStaticMarkup(
      <>
        <ProjectIdentityRows project={project({ hostId: "host_mini", hostName: "mini" })} />
        <ProjectConversationRows project={project({ hostId: "host_mini", hostName: "mini" })} envMode="local" />
      </>,
    );
    expect(html).toContain("Registered on mini");
    expect(html).toContain("inert");
  });

  test("a picked glyph outranks the checkout's icon, and can be cleared", () => {
    const marked = renderToStaticMarkup(<ProjectIdentityRows project={project({ iconName: "flask-conical", icon: "etag_abc" })} />);
    expect(marked).toContain("lucide-flask-conical");
    expect(marked).not.toContain("etag_abc");
    expect(marked).toContain('aria-label="Revert to the default"');
    expect(renderToStaticMarkup(<ProjectIdentityRows project={project()} />)).not.toContain('aria-label="Revert to the default"');
  });

  test("a mark typed before the picker existed still renders, and is revertible", () => {
    const typed = renderToStaticMarkup(<ProjectIdentityRows project={project({ iconEmoji: "🧵", icon: "etag_abc" })} />);
    expect(typed).toContain("🧵");
    expect(typed).toContain('aria-label="Revert to the default"');
    expect(typed).toContain("Typed mark");
  });

  test("a glyph name this build does not know falls through to auto-detect", () => {
    expect(isTelarIcon("not-a-glyph-in-this-build")).toBe(false);
    const html = renderToStaticMarkup(<ProjectIdentityRows project={project({ iconName: "not-a-glyph-in-this-build" })} />);
    expect(html).toContain("Auto-detect");
  });

  test("a project with no workspace answer follows the app default, and says what it is following", () => {
    const html = renderToStaticMarkup(<ProjectConversationRows project={project()} envMode="worktree" />);
    expect(html).toContain("Inherit (Own worktree)");
    expect(html).not.toContain("Follow the Mac");
    expect(html).toContain("Following the app default, which says each session gets its own checkout");
    expect(html).toContain("General ▸ Workspace");
  });

  test("a project that pinned an answer states it, whatever the app default says", () => {
    const html = renderToStaticMarkup(<ProjectConversationRows project={project({ envMode: "local" })} envMode="worktree" />);
    expect(html).toContain("Sessions here share the project");
    expect(html).toContain("checkout, whatever the app default says");
    expect(html).not.toContain("Following the app default");
  });

  test("the checkout path appears only once a project is named", () => {
    expect(renderToStaticMarkup(<ProjectIdentityRows />)).not.toContain("Checkout");
    expect(renderToStaticMarkup(<ProjectIdentityRows project={project()} />)).toContain("Checkout");
  });

  test("the workspace trigger states the inherited label, never the sentinel", () => {
    const html = renderToStaticMarkup(<ProjectConversationRows project={project()} envMode="worktree" />);
    expect(html).toContain(">Inherit (Own worktree)<");
    expect(html).not.toContain(">__follow-app<");
    expect(renderToStaticMarkup(<ProjectConversationRows project={project()} envMode="local" />)).toContain(">Inherit (Project checkout)<");
    expect(html).toContain('aria-label="Where new conversations start"');
    expect(html).not.toContain("aria-pressed");
  });

  test("a project on another Mac has read-only plugin switches, and the row says whose", () => {
    const html = renderToStaticMarkup(<ProjectPluginRows project={project({ hostId: "host_mini", hostName: "mini" })} plugins={[LATEX]} />);
    expect(html).toContain("LaTeX");
    expect(html).toContain("Registered on mini");
    expect(html).toContain("inert");
  });

  test("a plugin off for the whole Mac is inert in every project, and says where to turn it on", () => {
    const machine = { version: 1, entries: { latex: { enabled: false } } };
    const asked = project({ plugins: { version: 1, entries: { latex: { enabled: true } } } } as Partial<ScopedProject>);

    const rows = renderToStaticMarkup(<ProjectPluginRows project={asked} plugins={[LATEX]} machine={machine} />);
    expect(rows).toContain("LaTeX is off for every project on this Mac.");
    expect(rows).toContain('href="/settings?section=plugins"');
    expect(rows).toContain("inert");

    const panes = renderToStaticMarkup(<ProjectPluginPanes project={asked} plugins={[LATEX]} machine={machine} onChange={() => {}} />);
    expect(panes).toContain("LaTeX is off for every project on this Mac.");
    expect(panes).toContain("inert");

    expect(renderToStaticMarkup(<ProjectPluginRows project={asked} plugins={[LATEX]} />)).not.toContain("off for every project");
  });

  test("with no plugins registered the group says so rather than heading empty air", () => {
    expect(renderToStaticMarkup(<ProjectPluginRows plugins={[]} />)).toContain("No plugins registered");
  });

  test("the pane's first paint is All projects, with nothing bound", () => {
    const html = renderToStaticMarkup(<ProjectsPage />);
    expect(html).toContain('data-slot="select-value" class="flex flex-1 text-left">All projects<');
    expect(html).toContain("Select a project to rename it.");
    expect(html).not.toContain("Remove project from Telar");
    expect(html).not.toContain(">This Mac<");
  });
});

describe("model rows", () => {
  const modelRow = (id: string, options: { efforts?: string[]; fastMode?: boolean } = {}): ProviderModel => ({
    id,
    label: id,
    isDefault: false,
    hidden: false,
    hiddenByUser: false,
    legacy: false,
    efforts: options.efforts ?? [],
    fastMode: options.fastMode ?? false,
    source: "provider",
  });
  const MODELS = [modelRow("opus", { efforts: ["low", "medium", "high"], fastMode: true }), modelRow("haiku")];

  test("the options row shows effort and fast mode only for a model that has them", () => {
    const render = (choice: ModelChoice) =>
      renderToStaticMarkup(<ProjectModelOptionsRow driver="claude" choice={choice} models={MODELS} onChange={() => undefined} />);
    const opus = render({ model: "opus", effort: "medium", fastMode: true });
    expect(opus).toContain("Model options");
    expect(opus).toContain("New conversations in this project start with this model and these options.");
    expect(opus).toContain("Medium");
    expect(opus).toContain("Fast");
    expect(render({ model: "haiku" })).toBe("");
    expect(renderToStaticMarkup(<ProjectModelOptionsRow driver="claude" choice={{ model: "opus" }} onChange={() => undefined} />)).toBe("");
  });

  test("the options row's revert keeps the bare model", async () => {
    const changes: ModelChoice[] = [];
    const view = await mount(<ProjectModelOptionsRow driver="claude" choice={{ model: "opus", effort: "high" }} models={MODELS} onChange={(next) => void changes.push(next)} />);
    await press(view.button("Revert to the default"));
    expect(changes).toEqual([{ model: "opus" }]);
    view.done();
    expect(renderToStaticMarkup(<ProjectModelOptionsRow driver="claude" choice={{ model: "opus" }} models={MODELS} onChange={() => undefined} />)).not.toContain("Revert to the default");
  });

  test("the model row's revert writes null, which clears the options with it", async () => {
    const { saved, writer } = writerSpy();
    const view = await mount(<ProjectConversationRows project={project({ defaultModel: { instanceId: "claude", model: "opus" } } as Partial<ScopedProject>)} envMode="local" writer={writer} />);
    await press(view.button("Revert to the default"));
    expect(saved).toEqual([["defaultModel", { defaultModel: null }]]);
    view.done();
  });

  test("the options on offer are the composer's own, per model", () => {
    expect(modelOptionsOf(MODELS, { model: "opus" })).toEqual({ efforts: ["low", "medium", "high"], fastMode: true, serviceTiers: [], ultracode: false });
    expect(modelOptionsOf(MODELS, { model: "haiku" })).toEqual({ efforts: [], fastMode: false, serviceTiers: [], ultracode: false });
  });
});

describe("row writes", () => {
  test("the icon picker offers the shared set, and a pick writes the glyph's name", async () => {
    const { saved, writer } = writerSpy();
    const view = await mount(<ProjectIdentityRows project={project()} writer={writer} />);
    await press(view.button("Project icon"));
    for (const id of TELAR_ICONS) expect(document.querySelector(`button[aria-pressed][aria-label="${id.charAt(0).toUpperCase() + id.slice(1).replace(/-/g, " ")}"]`)).not.toBeNull();
    await press(view.button("Flask conical"));
    expect(saved).toEqual([["iconName", { iconName: "flask-conical" }]]);
    view.done();
  });

  test("Auto-detect clears both icon fields, a typed mark included", async () => {
    const { saved, writer } = writerSpy();
    const view = await mount(<ProjectIdentityRows project={project({ iconEmoji: "🧵" })} writer={writer} />);
    await press(view.button("Revert to the default"));
    await press(view.button("Project icon"));
    await press([...document.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes("No icon file found")));
    expect(saved).toEqual([
      ["iconName", { iconName: null, iconEmoji: null }],
      ["iconName", { iconName: null, iconEmoji: null }],
    ]);
    view.done();
  });

  test("the workspace row pins either answer, and Inherit writes null", async () => {
    const { saved, writer } = writerSpy();
    const view = await mount(<ProjectConversationRows project={project({ envMode: "local" })} envMode="worktree" writer={writer} />);
    const trigger = view.host.querySelector('[aria-label="Where new conversations start"]')!;
    await press(trigger);
    expect(options()).toEqual(["Inherit (Own worktree)", "Project checkout", "Own worktree"]);
    await press(option("Own worktree"));
    await press(trigger);
    await press(option("Inherit (Own worktree)"));
    expect(saved).toEqual([
      ["envMode", { envMode: "worktree" }],
      ["envMode", { envMode: null }],
    ]);
    view.done();
  });

  test("a plugin switch patches the named project, and does nothing without one", async () => {
    const unbound = await mount(<ProjectPluginRows plugins={[LATEX]} />);
    await press(unbound.host.querySelector('[role="switch"]')!);
    unbound.done();
    expect(calls.filter((call) => call.method === "PATCH")).toEqual([]);

    const bound = await mount(<ProjectPluginRows project={project()} plugins={[LATEX]} />);
    await press(bound.host.querySelector('[role="switch"]')!);
    expect(calls.filter((call) => call.method === "PATCH")).toEqual([{ method: "PATCH", url: "/api/projects/project_abc", body: enablePatch("latex", true) }]);
    bound.done();
  });
});

describe("the pane", () => {
  test("a registry of one is selected at once, with no way back to All projects", async () => {
    const view = await mount(<ProjectsPage />);
    expect(view.scope()).toBe("Telar");
    expect(view.host.querySelector<HTMLInputElement>('[aria-label="Project name"]')!.value).toBe("Telar");
    await press(view.trigger());
    expect(options()).toEqual(["Telar"]);
    view.done();
  });

  test("with several projects it stays on All projects and offers each", async () => {
    local = [project(), project({ id: "project_b", name: "Other" })];
    const view = await mount(<ProjectsPage />);
    expect(view.scope()).toBe("All projects");
    expect(view.host.textContent).toContain("Which of this Mac's plugins this project has opted into.");
    expect(view.host.textContent).not.toContain("Tool servers only this project's sessions see.");
    await press(view.trigger());
    expect(options()).toEqual(["All projects", "Telar", "Other"]);
    view.done();
  });

  test("?project= opens on that project; an id the registry lacks reads as words", async () => {
    local = [project(), project({ id: "project_b", name: "Other" })];
    window.history.replaceState(null, "", "/settings?section=projects&project=project_b");
    const named = await mount(<ProjectsPage />);
    expect(named.scope()).toBe("Other");
    named.done();

    window.history.replaceState(null, "", "/settings?section=projects&project=project_gone");
    const missing = await mount(<ProjectsPage />);
    expect(missing.scope()).toBe("Select a project");
    missing.done();
  });

  test("a named local project gets its own groups instead of the compact switch list", async () => {
    const view = await mount(<ProjectsPage />);
    const text = view.host.textContent ?? "";
    expect(text).toContain("Tool servers only this project's sessions see.");
    expect(text).toContain("Remove project from Telar");
    expect(text).not.toContain("Which of this Mac's plugins this project has opted into.");
    view.done();
  });

  test("a rename patches the named project and shows the engine's record", async () => {
    const view = await mount(<ProjectsPage />);
    await rename(view.host.querySelector<HTMLInputElement>('[aria-label="Project name"]')!, "Loom");
    expect(calls.filter((call) => call.method === "PATCH")).toEqual([{ method: "PATCH", url: "/api/projects/project_abc", body: { name: "Loom" } }]);
    expect(view.host.querySelector<HTMLInputElement>('[aria-label="Project name"]')!.value).toBe("Loom (kept)");
    view.done();
  });

  test("a paired Mac's registry is read only when chosen, and its project is never written", async () => {
    hosts = [{ id: "host_mini", name: "mini" }];
    remote = [project({ id: "project_far", name: "Far" })];
    const view = await mount(<ProjectsPage />);
    expect(view.button("This Mac")).toBeDefined();
    expect(calls.some((call) => call.url.startsWith("/api/hosts/host_mini"))).toBe(false);

    await press(view.button("mini"));
    expect(calls.some((call) => call.url === "/api/hosts/host_mini/projects")).toBe(true);
    expect(view.scope()).toBe("Far");
    expect(view.host.textContent).toContain("Registered on mini");
    expect(view.host.textContent).toContain("Which of this Mac's plugins this project has opted into.");
    expect(view.host.textContent).not.toContain("Tool servers only this project's sessions see.");

    await rename(view.host.querySelector<HTMLInputElement>('[aria-label="Project name"]')!, "Near");
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);
    view.done();
  });
});

test("the retired per-project route's target is this pane", () => {
  expect(projectSettingsHref("a b")).toBe("/settings?section=projects&project=a%20b");
});

test("the pane's rows are findable by search before the pane has ever been opened", () => {
  const first = (query: string) => searchSettings(SETTINGS_SEARCH_INDEX, query)[0];
  expect(first("project icon")?.pageId).toBe("projects");
  expect(first("unregister")?.title).toBe("Remove project from Telar");
  expect(first("unregister")?.pageId).toBe("projects");
  expect(first("all projects")?.pageId).toBe("projects");
});
