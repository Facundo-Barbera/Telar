// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const WEB_ROOT = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, WEB_ROOT), "utf8");

describe("background session observer cadence", () => {
  test("uses events for normal refreshes and slow, visibility-aware safety polls", () => {
    const host = read("components/dock/session-runtime-host.tsx");
    expect(host).toContain("const DETAIL_SAFETY_POLL_MS = 60_000");
    expect(host).toContain("const IDLE_TAIL_RETRY_MS = 30_000");
    expect(host).not.toContain("setInterval(refetch, 8000)");
    expect(host).not.toContain("sawEvent ? 800 : 3500");
    expect(host).toContain('document.visibilityState === "visible"');
    expect(host).toContain("enqueueIdleRequest(budgetKey, refetch)");
    expect(host).toContain("enqueueIdleRequest(budgetKey, openTail)");
    expect(host).toContain("cancelIdleRequest(budgetKey)");
    expect(host).toContain("TELAR_SESSION_RUN_EVENT");
    expect(host).toContain("TELAR_REFRESH_EVENT");
    expect(host).toContain("if (refetching) return");
    expect(host).toContain('"dock session detail"');
    expect(host).toContain('"dock live tail"');
  });

  test("pauses global Ultra discovery in background tabs", () => {
    const signal = read("components/common/ultra-dock-signal.tsx");
    expect(signal).toContain('document.visibilityState !== "visible"');
    expect(signal).toContain('document.addEventListener("visibilitychange"');
    expect(signal).toContain("schedule(hasLiveRuns.current ? LIVE_POLL_MS : IDLE_POLL_MS)");
  });
});
