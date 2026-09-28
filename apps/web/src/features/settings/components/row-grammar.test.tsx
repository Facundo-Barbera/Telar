// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { Project } from "@telar/engine-client";
import { detachFromHost } from "@/features/appearance/index";

GlobalRegistrator.register({ url: "http://mini.tailnet:3000/settings" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(async () => await GlobalRegistrator.unregister());

const navigation = await import("next/navigation");
mock.module("next/navigation", () => ({
  ...navigation,
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
}));

const { PackagesPanel } = await import("@/features/plugins/components/packages-panel");
const { Dropdown } = await import("./settings-shell");
const { WorkspaceSection } = await import("@/features/projects/components/workspace-section");
const { TextGenSection } = await import("@/features/providers/components/textgen-section");
const { DataScienceSection } = await import("@/features/plugins/data-science/data-science-section");
const { LooksSection } = await import("@/features/appearance/components/looks-section");

test("the packages fields are Rows with names, not unlabelled blocks", () => {
  const html = renderToStaticMarkup(<PackagesPanel scope={{ projectId: "project_a" }} />);
  expect(html).toContain("Install packages");
  expect(html).toContain('id="settings-row-environment-install-packages"');
  expect(html).toContain('<span class="flex size-3 shrink-0 items-center justify-center">');
});

test("with no environment resolved, the install field says so instead of sitting dead", () => {
  const html = renderToStaticMarkup(<PackagesPanel scope={{ projectId: "project_a" }} />);
  expect(html).toContain("No Python environment was resolved for this project.");
  expect(html).toContain("inert=");
});

test("the session's narrow column keeps the rows and drops the group frame", () => {
  const dense = renderToStaticMarkup(<PackagesPanel scope={{ sessionId: "session_a" }} dense />);
  expect(dense).toContain("Install packages");
  expect(dense).not.toContain("<h4");
  expect(renderToStaticMarkup(<PackagesPanel scope={{ projectId: "project_a" }} />)).toContain("<h4");
});

async function mountOffline(node: React.ReactNode) {
  const [realFetch, realSetTimeout] = [globalThis.fetch, window.setTimeout];
  globalThis.fetch = (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;
  window.setTimeout = ((fn: () => void) => void queueMicrotask(fn)) as unknown as typeof window.setTimeout;
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(node));
  for (let i = 0; i < 20; i++) await act(async () => await Promise.resolve());
  return {
    host,
    done: () => {
      act(() => root.unmount());
      globalThis.fetch = realFetch;
      window.setTimeout = realSetTimeout;
    },
  };
}

test("a dropdown's trigger reads the chosen label, never the value", () => {
  const html = renderToStaticMarkup(<Dropdown value="__auto" onChange={() => {}} options={[{ value: "__auto", label: "Automatic" }]} />);
  expect(html).toContain(">Automatic<");
  expect(html).not.toContain(">__auto<");
});

test("an enumeration setting is a dropdown, and a boolean is still a switch", async () => {
  for (const node of [<WorkspaceSection key="w" />, <TextGenSection key="t" />]) {
    const view = await mountOffline(node);
    expect(view.host.querySelector('[data-slot="select-trigger"]')).not.toBeNull();
    expect(view.host.querySelector("[aria-pressed]")).toBeNull();
    expect(view.host.querySelector('[role="switch"]')).not.toBeNull();
    view.done();
  }
});

test("a plugin pane heads its groups with whose they are, never a bare 'Packages'", () => {
  const html = renderToStaticMarkup(<DataScienceSection project={{ id: "project_1", name: "Telar", root: "/tmp/telar" } as Project} onChange={() => {}} />);
  expect(html).toContain(">Python tools<");
  expect(html).not.toContain(">Packages<");
});

test("the host-look row keeps Retry live when there is nothing to follow", async () => {
  detachFromHost();
  const { host, done } = await mountOffline(<LooksSection onWear={() => {}} />);
  try {
    const retry = [...host.querySelectorAll("button")].find((button) => button.textContent === "Retry");
    expect(host.textContent).toContain("The engine did not answer.");
    expect(retry?.disabled).toBe(false);
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Follow the host\'s look"]')?.hasAttribute("data-disabled")).toBe(true);
    expect(host.querySelector("#settings-row-appearance-host-look [inert]")).toBeNull();
  } finally {
    done();
  }
});
