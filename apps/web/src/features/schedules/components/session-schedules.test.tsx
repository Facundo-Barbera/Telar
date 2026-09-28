/**
 * THE MASTHEAD'S SCHEDULE INDICATOR: absent with nothing scheduled, a count
 * with something, and a popover that lists and deletes this session's rows.
 *
 * Mounted against a stubbed `fetch`, because what matters is which requests go
 * out — the read is narrowed to this session, and delete names the row.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Schedule } from "@telar/engine-client";
import { SessionSchedules } from "./session-schedules";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const row = (over: Partial<Schedule> = {}): Schedule => ({
  id: "sched_1",
  sessionId: "session_1",
  prompt: "daily digest",
  rule: { kind: "fixed", hour: 9, minute: 0, weekdays: [1, 2, 3, 4, 5] },
  zone: "Europe/Madrid",
  enabled: true,
  createdAt: Date.UTC(2026, 4, 1),
  nextRunAt: Date.UTC(2026, 5, 2, 7, 0, 0),
  ...over,
});

const realFetch = globalThis.fetch;
let calls: { method: string; url: string }[] = [];
let root: Root | undefined;
let host: HTMLDivElement | undefined;

function stub(rows: Schedule[]) {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    calls.push({ method, url });
    return method === "DELETE" ? Response.json({ deleted: true }) : Response.json({ schedules: rows });
  }) as typeof globalThis.fetch;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<SessionSchedules sessionId="session_1" hostId="local" />);
    await settle();
  });
  await act(settle);
}

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
  globalThis.fetch = realFetch;
});

describe("the session's schedules", () => {
  test("renders nothing when the session has no schedules", async () => {
    stub([]);
    await mount();
    expect(calls).toEqual([{ method: "GET", url: "/api/schedules?sessionId=session_1" }]);
    expect(host!.innerHTML).toBe("");
  });

  test("shows a count, lists each schedule, and deletes one", async () => {
    stub([row(), row({ id: "sched_2", prompt: "check the deploy", rule: { kind: "interval", everyMs: 3_600_000 } })]);
    await mount();

    const trigger = host!.querySelector("button")!;
    expect(trigger.getAttribute("aria-label")).toBe("2 schedules");
    expect(trigger.textContent).toContain("2");

    await act(async () => {
      trigger.click();
      await settle();
    });
    const text = document.body.textContent ?? "";
    expect(text).toContain("daily digest");
    expect(text).toContain("Every weekday at 09:00");
    expect(text).toContain("check the deploy");
    expect(text).toContain("Every 1 hour");

    const deletes = document.body.querySelectorAll<HTMLButtonElement>('button[aria-label="Delete schedule"]');
    expect(deletes).toHaveLength(2);
    await act(async () => {
      deletes[0]!.click();
      await settle();
    });
    expect(calls.at(-1)).toEqual({ method: "DELETE", url: "/api/schedules/sched_1" });
    expect(document.body.textContent).not.toContain("daily digest");
    expect(host!.querySelector("button")!.getAttribute("aria-label")).toBe("1 schedule");
  });
});
