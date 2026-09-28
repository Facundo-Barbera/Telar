import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const PROJECT = "project_700d027bd7584c5e8486736ec0253f71";

GlobalRegistrator.register({ url: `http://localhost/projects/${PROJECT}/sessions/new` });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
  observe() {}
  disconnect() {}
  unobserve() {}
};

mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => `/projects/${PROJECT}/sessions/new`,
  useSearchParams: () => new URLSearchParams(),
}));

const { SessionCockpit } = await import("./session-cockpit");
const { SidebarProvider } = await import("@/ui/sidebar");

const realFetch = globalThis.fetch;
// The engine client's read gate is shared by the file, so a held read must be let go.
let held: (() => void)[] = [];

function wire(projects: () => Promise<Response>) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/api/projects") && !url.includes(`/api/projects/`)) return projects();
    if (url.includes("/api/session-defaults")) return Response.json({ sessionDefaults: { envMode: "local" } });
    if (url.includes("/browser")) return Response.json({ browser: { tabs: [], canStart: false } });
    return Response.json({});
  }) as typeof fetch;
}

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(async () => {
  for (const release of held) release();
  held = [];
  globalThis.fetch = realFetch;
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  window.localStorage.clear();
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

async function settle() {
  for (let pass = 0; pass < 8; pass += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function openCanvas() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <SidebarProvider>
        <SessionCockpit projectId={PROJECT} />
      </SidebarProvider>,
    );
  });
  await settle();
}

const heading = () => document.querySelector("h1")?.textContent ?? "";
const strip = () => document.querySelector('[aria-label="Where this lands"]')?.textContent ?? "";

describe("a new conversation on a project the list has not caught up with", () => {
  test("never titles the canvas with the project's id", async () => {
    wire(() => new Promise<Response>((resolve) => {
      held.push(() => resolve(Response.json({ projects: [] })));
    }));
    await openCanvas();
    expect(heading()).toBe("What's next for this project?");
    expect(document.body.textContent).not.toContain(PROJECT);
    expect(strip()).not.toContain("project_");
  });

  test("names the project as soon as the list answers", async () => {
    wire(async () => Response.json({ projects: [{ id: PROJECT, name: "exoplanets", root: "/tmp" }] }));
    await openCanvas();
    expect(heading()).toBe("What's next for exoplanets?");
    expect(document.body.textContent).not.toContain(PROJECT);
  });
});
