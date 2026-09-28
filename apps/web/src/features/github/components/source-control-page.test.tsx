// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { searchSettings, SETTINGS_SEARCH_INDEX } from "@/features/settings/index";
import { SourceControlPage, readGhState } from "./source-control-page";

GlobalRegistrator.register({ url: "http://localhost/settings" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(async () => await GlobalRegistrator.unregister());

const flush = async () => {
  for (let i = 0; i < 20; i++) await act(async () => await Promise.resolve());
};

test("no GitHub remote means gh works, not that anything is wrong", () => {
  expect(readGhState({ unavailable: "no_repository" })).toEqual({ status: "ready" });
  expect(readGhState({ repository: "NovarixHQ/Telar" })).toEqual({ status: "ready", repository: "NovarixHQ/Telar" });
  expect(readGhState({ unavailable: "not_github" })).toEqual({ status: "ready" });
});

test("the two machine-level failures are carried through as themselves", () => {
  expect(readGhState({ unavailable: "not_installed" })).toEqual({ status: "unavailable", reason: "not_installed" });
  expect(readGhState({ unavailable: "not_authenticated" })).toEqual({ status: "unavailable", reason: "not_authenticated" });
  expect(readGhState({ unavailable: "failed", message: "dial tcp: i/o timeout" })).toEqual({ status: "unavailable", reason: "failed", message: "dial tcp: i/o timeout" });
});

test("the row is drawn before the probe answers", () => {
  const html = renderToStaticMarkup(<SourceControlPage />);
  expect(html).toContain("GitHub");
  expect(html).toContain("Read through a CLI you signed in to yourself");
  expect(html).not.toContain("Sessions get the same access you have in a terminal");
});

test("no row exists only to say a thing does not exist", () => {
  const html = renderToStaticMarkup(<SourceControlPage />);
  expect(html).not.toContain("GitLab");
  expect(html).not.toContain("Not supported");
});

test("a broken gh names the command that fixes it, and Check again re-asks", async () => {
  let github: Record<string, unknown> = { unavailable: "not_installed" };
  const asked: string[] = [];
  const [realFetch, realSetTimeout] = [globalThis.fetch, window.setTimeout];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    asked.push(String(input));
    const body = String(input) === "/api/projects" ? { projects: [{ id: "project_a", name: "A", root: "/a" }] } : { github };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  window.setTimeout = ((fn: () => void) => void queueMicrotask(fn)) as unknown as typeof window.setTimeout;
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(<SourceControlPage />));
    await flush();
    expect(host.textContent).toContain("brew install gh");

    github = { unavailable: "not_authenticated" };
    await act(async () => host.querySelector<HTMLElement>('[aria-label="Check gh again"]')!.click());
    await flush();
    expect(host.textContent).toContain("gh auth login");
    expect(host.textContent).not.toContain("brew install gh");
    expect(asked.at(-1)).toBe("/api/projects/project_a/github?refresh=1");
  } finally {
    act(() => root.unmount());
    globalThis.fetch = realFetch;
    window.setTimeout = realSetTimeout;
  }
});

test("search finds the pane by the CLI, not only by its name", () => {
  const first = (query: string) => searchSettings(SETTINGS_SEARCH_INDEX, query)[0];
  expect(first("gh cli")?.pageId).toBe("source-control");
  expect(first("github")?.pageId).toBe("source-control");
  expect(first("source control")?.pageId).toBe("source-control");
});
