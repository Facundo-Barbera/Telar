import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { UsageDiagnosis } from "@telar/engine-client";

GlobalRegistrator.register({ url: "http://localhost/usage" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { SendDiagnosisFeedback } = await import("./diagnosis-feedback");

const diagnosis: UsageDiagnosis = {
  id: "diag_1",
  sessionId: "session_diag",
  runId: "run_1",
  state: "ready",
  createdAt: 1,
  model: "sonnet · medium",
  promptVersion: 1,
  totals: { tokens: { input: 0, output: 0, cacheRead: 2_000_000, cacheCreate: 0 }, costUsd: 4.5, turns: 10, sessions: 2, cacheHit: 0.98 },
  names: { s1: "Fix the login page", p1: "Acme Rocket" },
  report: {
    window: "30d",
    summary: "Most tokens are cache reads in one long session.",
    topConsumers: [{ id: "s1", share: 0.7, reason: "900 turns" }],
    findings: [{ signal: "long_lived_session", severity: "high", title: "One session runs for ever", why: "Each turn re-reads it.", evidence: [{ metric: "turns", value: 900 }], fix: { setting: "compaction", action: "Start fresh sessions." } }],
  },
};

const realFetch = globalThis.fetch;
const opened = mock((_url: string) => Promise.resolve());
let root: Root | undefined;
let host: HTMLDivElement | undefined;

beforeEach(async () => {
  opened.mockClear();
  (window as unknown as { telarDesktop: unknown }).telarDesktop = { browser: { openExternal: opened } };
  globalThis.fetch = (async () => Response.json({ appVersion: "1.4.0", appName: "Telar", channel: "beta" })) as unknown as typeof fetch;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<SendDiagnosisFeedback diagnosis={diagnosis} />));
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
  globalThis.fetch = realFetch;
});

afterAll(() => GlobalRegistrator.unregister());

const button = (text: string) => [...document.querySelectorAll("button")].find((each) => each.textContent === text)!;
const press = (el: Element) => act(async () => void (el as HTMLElement).click());

test("the preview shows the report without the local names, and that exact text is what opens", async () => {
  await press(button("Send as feedback"));

  const preview = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Issue text"]')!;
  expect(preview.readOnly).toBe(true);
  expect(preview.value).toContain("**Summary:** Most tokens are cache reads in one long session.");
  expect(preview.value).toContain("2.00M tokens · $4.50 · 98.0% cache reads");
  expect(preview.value).toContain("- s1: 70.0%. 900 turns");
  expect(preview.value).toContain("Fix (compaction): Start fresh sessions.");
  expect(preview.value).not.toContain("Fix the login page");
  expect(preview.value).not.toContain("Acme Rocket");
  expect(preview.value).not.toContain("session_diag");

  await press(button("Open issue"));

  const url = new URL(opened.mock.calls[0]![0]);
  expect(url.pathname).toBe("/NovarixHQ/Telar/issues/new");
  expect(url.searchParams.get("title")).toBe("Usage diagnosis report");
  expect(url.searchParams.get("body")).toBe(preview.value);
});
