// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { CleanupState, RetentionPolicy } from "@telar/engine-client";
import { CleanupSection, FIXED_RULES, lastCleanupLabel, runLabel } from "./cleanup-section";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
const OFF: CleanupState = { policy: { inactiveDays: null, merged: false, archived: false, logsDays: null }, running: false };
const ROOT = "/store/worktrees";

let state: CleanupState = OFF;
let retention: RetentionPolicy = { idleAfterDays: null, exportTo: null };
let calls: { url: string; method: string; body?: unknown }[] = [];
/** What the engine answers a PUT with — its own state, which may differ from the patch. */
let putAnswer: ((patch: Partial<CleanupState["policy"]>) => CleanupState) | undefined;
const realFetch = globalThis.fetch;

beforeEach(() => {
  state = OFF;
  retention = { idleAfterDays: null, exportTo: null };
  calls = [];
  putAnswer = undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    if (url.startsWith("/api/cleanup/run")) {
      state = { ...state, last: { at: Date.now() - 12 * 60_000, freedBytes: 8.4 * 1024 ** 3, released: 3, logs: 5, skipped: 1 } };
      return Response.json({ cleanup: state });
    }
    if (url.startsWith("/api/cleanup")) {
      if (method === "PUT") state = putAnswer ? putAnswer(body) : { ...state, policy: { ...state.policy, ...body } };
      return Response.json({ cleanup: state });
    }
    if (url.startsWith("/api/storage/retention")) {
      if (method === "PUT") retention = { ...retention, ...body };
      return Response.json({ retention, buckets: [] });
    }
    if (url.startsWith("/api/worktrees-root")) return Response.json({ worktreesRoot: { kind: "default", root: ROOT, default: ROOT } });
    return Response.json({});
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<CleanupSection />);
    await settle();
  });
  await act(async () => {
    await settle();
  });
  return {
    host,
    text: () => host.textContent ?? "",
    switches: () => [...host.querySelectorAll('[role="switch"]')] as HTMLElement[],
    button: (label: string) => [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label),
    click: async (element: Element) => {
      await act(async () => {
        element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        await settle();
      });
    },
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

describe("Settings ▸ Storage ▸ automatic cleanup", () => {
  test("the four controls render, all off by default", async () => {
    const view = await mount();
    for (const label of ["Delete inactive worktrees", "Delete merged worktrees", "Delete worktrees of archived sessions", "Delete old logs"]) {
      expect(view.text()).toContain(label);
    }
    const triggers = [...view.host.querySelectorAll('[aria-label="Delete inactive worktrees"], [aria-label="Delete old logs"]')];
    expect(triggers.map((trigger) => trigger.textContent?.replace("▼", "").trim())).toEqual(["Off", "Off"]);
    expect(view.switches().map((toggle) => toggle.getAttribute("aria-checked"))).toEqual(["false", "false"]);
    view.unmount();
  });

  test("the fixed rules are behind the ⓘ, once", async () => {
    const view = await mount();
    const infos = [...view.host.querySelectorAll("[data-info]")].map((node) => node.getAttribute("data-info"));
    expect(infos.filter((info) => info === FIXED_RULES)).toHaveLength(1);
    view.unmount();
  });

  test("a change PUTs only its patch and shows the engine's answer", async () => {
    // The engine answers with more than was asked for; the page shows the answer.
    putAnswer = (patch) => ({ ...state, policy: { ...state.policy, ...patch, inactiveDays: 7 } });
    const view = await mount();
    await view.click(view.switches()[0]!);
    expect(calls.find((call) => call.method === "PUT")).toEqual({ url: "/api/cleanup", method: "PUT", body: { merged: true } });
    expect(view.switches()[0]!.getAttribute("aria-checked")).toBe("true");
    expect(view.host.querySelector('[aria-label="Delete inactive worktrees"]')?.textContent).toContain("7 days");
    view.unmount();
  });

  test("a refused write says so on its row and leaves the control as stored", async () => {
    const view = await mount();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { code: "invalid", message: "The engine refused that." } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    await view.click(view.switches()[1]!);
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain("The engine refused that.");
    expect(view.switches()[1]!.getAttribute("aria-checked")).toBe("false");
    view.unmount();
  });

  test("Clean up now runs the sweep and shows what it did", async () => {
    const view = await mount();
    expect(view.text()).toContain("Never cleaned up");
    await view.click(view.button("Clean up now")!);
    expect(calls.some((call) => call.url === "/api/cleanup/run" && call.method === "POST")).toBe(true);
    expect(view.text()).toContain("Last cleanup: 12m ago · freed 8.4 GB");
    expect(view.text()).toContain("3 worktrees released, 5 logs deleted, 1 skipped");
    view.unmount();
  });

  test("the button is disabled while the engine reports a sweep running", async () => {
    state = { ...OFF, running: true };
    const view = await mount();
    const button = [...view.host.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes("Cleaning up"));
    expect(button?.hasAttribute("disabled")).toBe(true);
    view.unmount();
  });

  test("the worktree list is collapsed, and not fetched, until asked for", async () => {
    const view = await mount();
    expect(calls.some((call) => call.url.startsWith("/api/worktrees?") || call.url === "/api/worktrees")).toBe(false);
    expect(calls.some((call) => call.url.startsWith("/api/storage") && !call.url.startsWith("/api/storage/retention"))).toBe(false);
    await view.click(view.button("Show worktrees")!);
    // The list asks on a zero timeout after it mounts.
    await act(async () => {
      await settle();
    });
    expect(calls.some((call) => call.url === "/api/worktrees")).toBe(true);
    view.unmount();
  });

  test("a journal retention window already set stays visible, with a way to turn it off", async () => {
    const off = await mount();
    expect(off.text()).not.toContain("Turn journal retention");
    off.unmount();

    retention = { idleAfterDays: 30, exportTo: "/exports" };
    const view = await mount();
    expect(view.text()).toContain("Turn journal retention");
    expect(view.text()).toContain("/exports");
    await view.click(view.button("Turn off")!);
    expect(calls.at(-1)).toEqual({ url: "/api/storage/retention", method: "PUT", body: { idleAfterDays: null } });
    expect(view.text()).not.toContain("Turn journal retention");
    view.unmount();
  });
});

describe("the last-cleanup line", () => {
  test("says when there has been none", () => {
    expect(lastCleanupLabel(undefined)).toBe("Never cleaned up");
  });

  test("says how long ago and how much it freed", () => {
    const now = Date.UTC(2026, 8, 24, 12);
    expect(lastCleanupLabel({ at: now - 12 * 60_000, freedBytes: 8.4 * 1024 ** 3, released: 2, logs: 0, skipped: 0 }, now)).toBe(
      "Last cleanup: 12m ago · freed 8.4 GB",
    );
  });

  test("a run's counts are singular where they should be, and skip zero skipped", () => {
    expect(runLabel({ at: 0, freedBytes: 0, released: 1, logs: 1, skipped: 0 })).toBe("1 worktree released, 1 log deleted");
  });
});
