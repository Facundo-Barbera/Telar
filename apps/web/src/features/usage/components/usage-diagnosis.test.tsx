import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { UsageDiagnosis } from "@telar/engine-client";

GlobalRegistrator.register({ url: "http://localhost/usage" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { UsageDiagnosisSection } = await import("./usage-diagnosis");

const realFetch = globalThis.fetch;
let root: Root | undefined;
let host: HTMLDivElement | undefined;
const calls: Array<{ method: string; url: string; body?: unknown }> = [];

const base: UsageDiagnosis = { id: "diag_1", sessionId: "session_diag", runId: "run_1", state: "running", createdAt: 1, model: "sonnet · medium", promptVersion: 1 };
const ready: UsageDiagnosis = {
  ...base,
  state: "ready",
  totals: { tokens: { input: 0, output: 0, cacheRead: 2_000_000, cacheCreate: 0 }, costUsd: 4.5, turns: 10, sessions: 2, cacheHit: 0.98 },
  names: { s1: "Fix the login page" },
  report: {
    window: "30d",
    summary: "Most tokens are cache reads in one long session.",
    topConsumers: [{ id: "s1", share: 0.7, reason: "900 turns" }],
    findings: [{ signal: "long_lived_session", severity: "high", title: "One session runs for ever", why: "Each turn re-reads it.", evidence: [{ metric: "turns", value: 900 }], fix: { setting: "compaction", action: "Start fresh sessions." } }],
  },
};

async function mount(responses: Record<string, UsageDiagnosis | null>) {
  let loaded!: () => void;
  const firstLoad = new Promise<void>((resolve) => (loaded = resolve));
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (method === "GET") loaded();
    return Response.json({ diagnosis: responses[`${method} ${new URL(url, "http://localhost").pathname}`] ?? null });
  }) as typeof fetch;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<UsageDiagnosisSection />));
  await act(async () => firstLoad);
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
  globalThis.fetch = realFetch;
  calls.length = 0;
});

afterAll(() => GlobalRegistrator.unregister());

const button = (text: string) => [...document.querySelectorAll("button")].find((each) => each.textContent === text)!;
const press = (el: Element) => act(async () => void (el as HTMLElement).click());

test("with no diagnosis yet, the chosen model starts one and the card shows it running", async () => {
  await mount({ "POST /api/usage/diagnosis": base });
  expect(document.body.textContent).toContain("explains what drives it");

  await press(button("Haiku"));
  await press(button("Diagnose usage"));

  expect(calls.find((call) => call.method === "POST")).toMatchObject({ url: "/api/usage/diagnosis", body: { model: "haiku", effort: "medium" } });
  expect(document.querySelector('[role="status"]')?.textContent).toContain("Diagnosing with sonnet · medium");
  expect(button("Diagnose usage")).toBeUndefined();
});

test("a running diagnosis can be stopped", async () => {
  await mount({ "GET /api/usage/diagnosis": base, "POST /api/usage/diagnosis/stop": { ...base, state: "failed", error: "The diagnosis was stopped." } });

  await press(button("Stop"));

  expect(calls.at(-1)).toMatchObject({ method: "POST", url: "/api/usage/diagnosis/stop" });
  expect(document.body.textContent).toContain("The diagnosis was stopped.");
  expect(button("Run again")).toBeDefined();
});

test("a ready report shows its figures, the local session name and each finding's fix", async () => {
  await mount({ "GET /api/usage/diagnosis": ready });

  const text = document.body.textContent ?? "";
  expect(text).toContain("Most tokens are cache reads in one long session.");
  expect(text).toContain("$4.50");
  expect(text).toContain("98.0%");
  expect(document.querySelector('[aria-label="Top consumers"]')?.textContent).toContain("Fix the login page");
  const finding = document.querySelector('[aria-label="Findings"] li')!.textContent!;
  expect(finding).toContain("One session runs for ever");
  expect(finding).toContain("turns 900");
  expect(finding).toContain("Settings → Providers → Compaction: Start fresh sessions.");
  expect(document.querySelector('a[href="/sessions/session_diag"]')?.textContent).toBe("Open transcript");
  expect(text).not.toContain("engine's own checks");
});

test("a fallback report says it came from the engine's own checks", async () => {
  await mount({ "GET /api/usage/diagnosis": { ...ready, fallback: true } });

  expect(document.body.textContent).toContain("this report comes from the engine's own checks");
});
