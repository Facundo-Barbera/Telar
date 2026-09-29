import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => "/settings",
  useSearchParams: () => new URLSearchParams("section=providers"),
}));

GlobalRegistrator.register({ url: "http://localhost/settings?section=providers" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { SettingsPage } = await import("./settings-page");

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/provider-instances")) {
      return json({ providerInstances: [{ id: "claude", driver: "claude", enabled: true, env: [], createdAt: 1, updatedAt: 1 }], probes: [] });
    }
    if (url.startsWith("/api/usage/sources")) return json({ sources: [{ id: "home-hub", label: "Home hub", url: "http://localhost:8317", enabled: true, keyRedacted: "…abcd" }] });
    return json({});
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  document.body.innerHTML = "";
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

test("Providers keeps usage hubs in their own section after the logins, outside the list", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<SettingsPage />));
  for (let i = 0; i < 500 && !host.textContent?.includes("Home hub"); i++) {
    await act(async () => await Promise.resolve());
  }
  const list = host.querySelector('[role="listbox"][aria-label="Logins"]')!;
  expect(list).not.toBeNull();
  expect(list.textContent).not.toContain("Home hub");
  const usage = [...host.querySelectorAll("section")].find((section) => section.textContent?.includes("Usage providers"))!;
  expect(usage.textContent).toContain("Home hub");
  expect(list.compareDocumentPosition(usage) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(usage.contains(list)).toBe(false);
  act(() => root.unmount());
});
