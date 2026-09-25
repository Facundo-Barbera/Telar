/**
 * A NEW CONVERSATION'S COMPOSER STARTS FROM THE PROJECT'S DEFAULT — its model,
 * effort and fast mode — so "this project always runs Opus at medium" is what
 * the canvas shows, and changing one knob keeps the rest.
 *
 * MOUNTED FOR REAL on a fresh canvas, because the seed lands when the project
 * record answers and has to lose to a human pick made at any point after.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ModelSelection, ProviderModel } from "@telar/engine-client";

GlobalRegistrator.register({ url: "http://localhost/projects/project_1/sessions/new" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
  observe() {}
  disconnect() {}
  unobserve() {}
};

mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => "/projects/project_1/sessions/new",
  useSearchParams: () => new URLSearchParams(),
}));

const { SessionCockpit } = await import("./session-cockpit");
const { SidebarProvider } = await import("@/components/ui/sidebar");

const row = (id: string, label: string, efforts: string[], isDefault = false): ProviderModel => ({
  id,
  label,
  isDefault,
  hidden: false,
  hiddenByUser: false,
  legacy: false,
  efforts,
  fastMode: false,
  source: "provider",
});
const MODELS = [row("claude-sonnet-5", "Sonnet", ["low", "medium", "high"], true), row("claude-opus-5", "Opus", ["low", "medium", "high"])];

const realFetch = globalThis.fetch;

function wire(defaultModel?: ModelSelection) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/api/projects")) {
      return Response.json({ projects: [{ id: "project_1", name: "exoplanets", root: "/tmp", ...(defaultModel ? { defaultModel } : {}) }] });
    }
    if (url.includes("/api/session-defaults")) return Response.json({ sessionDefaults: { envMode: "local" } });
    if (url.includes("/api/models")) return Response.json({ catalogue: { driver: "claude", instanceId: "claude", readAt: 1, models: MODELS } });
    if (url.includes("/browser")) return Response.json({ browser: { tabs: [], canStart: false } });
    return Response.json({});
  }) as typeof fetch;
}

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(async () => {
  globalThis.fetch = realFetch;
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

/** The opening is a promise chain behind deferred tasks; a fixed sleep would flake. */
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
        <SessionCockpit projectId="project_1" projectName="exoplanets" />
      </SidebarProvider>,
    );
  });
  await settle();
}

const pill = (name: RegExp) => [...document.querySelectorAll("button")].find((button) => name.test(button.getAttribute("aria-label") ?? ""));

describe("a new conversation's composer", () => {
  test("starts from the project's default model and effort", async () => {
    wire({ instanceId: "claude", model: "claude-opus-5", effort: "medium" });
    await openCanvas();
    expect(pill(/^Model: /)?.getAttribute("aria-label")).toContain("Opus");
    expect(pill(/^Reasoning effort: /)?.getAttribute("aria-label")).toContain("Medium");
  });

  test("changing the effort keeps the project's model", async () => {
    wire({ instanceId: "claude", model: "claude-opus-5", effort: "medium" });
    await openCanvas();
    await act(async () => pill(/^Reasoning effort: /)!.click());
    await settle();
    const high = [...document.querySelectorAll("[role='menuitemradio'], button, [role='option']")].find((node) => node.textContent?.trim() === "High");
    expect(high).toBeDefined();
    await act(async () => (high as HTMLElement).click());
    await settle();
    expect(pill(/^Reasoning effort: /)?.getAttribute("aria-label")).toContain("High");
    expect(pill(/^Model: /)?.getAttribute("aria-label")).toContain("Opus");
  });

  test("without a project default, stays on the provider's default as before", async () => {
    wire();
    await openCanvas();
    expect(pill(/^Model: /)?.getAttribute("aria-label")).toContain("Sonnet");
    expect(pill(/^Reasoning effort: /)?.getAttribute("aria-label")).toContain("Auto");
  });
});
