/**
 * TURNING LATEX ON CHOOSES NOTHING ELSE.
 *
 * The switch used to pin the one distribution discovery found, so a project
 * enabled on a Mac with only Tectonic stored `toolchain: tectonic` and stopped
 * following this Mac's default without anyone picking it. The project stays on
 * Inherit until a person presses Use on a card.
 *
 * THE ASSERTION IS ON THE WRITE the engine receives, not on the cards: "In use"
 * on the Inherit card could be drawn over a stored pin.
 */
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { LatexDistributions, Project } from "@telar/engine-client";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

const { LatexSection } = await import("./latex-section");

const PROJECT = { id: "project_1", name: "Paper", root: "/tmp/paper" } as unknown as Project;

/** Exactly one distribution on this Mac: the case the switch used to pin. */
const ONE_DISTRIBUTION: LatexDistributions = {
  toolchain: { tectonic: { path: "/opt/homebrew/bin/tectonic", version: "0.15.0" }, texlive: [] },
  mainCandidates: [],
} as unknown as LatexDistributions;

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

let written: unknown[] = [];
const realFetch = globalThis.fetch;
const realSetTimeout = window.setTimeout;

beforeEach(() => {
  written = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/latex/distributions")) return json(ONE_DISTRIBUTION);
    if (url.includes("/api/plugins")) return json({ plugins: [], machine: { entries: {} } });
    if (init?.method === "PATCH" || init?.method === "PUT" || init?.method === "POST") {
      // Writes go through the plugin map now (`blockPatch`), not the legacy block.
      const body = JSON.parse(String(init.body));
      const latex = body.plugins?.latex;
      written.push(latex);
      return json({ project: { ...PROJECT, plugins: { version: 1, entries: latex ? { latex } : {} } } });
    }
    return json({});
  }) as typeof fetch;
  // The section defers its first probe by a zero-length timeout. Run it as a
  // microtask instead, so the test waits on no clock.
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

/** Lets queued microtasks and the fetch stub's promises land. */
const flush = async () => {
  for (let i = 0; i < 20; i++) await act(async () => await Promise.resolve());
};

test("enabling with one distribution found leaves the project on Inherit", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<LatexSection project={PROJECT} onChange={() => {}} />);
  });
  await flush();
  // The probe has answered: the Tectonic card offers Use.
  expect(host.textContent).toContain("/opt/homebrew/bin/tectonic");

  const toggle = host.querySelector('[aria-label="Enable LaTeX for this project"]') as HTMLElement;
  await act(async () => toggle.click());
  await flush();

  expect(written).toEqual([{ enabled: true }]);
  act(() => root.unmount());
  host.remove();
});
