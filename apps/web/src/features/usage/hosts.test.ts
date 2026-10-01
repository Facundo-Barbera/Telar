import { describe, expect, test } from "bun:test";
import type { UsageBucket, UsageReport } from "@telar/engine-client";
import { ALL_HOSTS, combineReports, hostRows, reportFor, type HostUsage } from "./hosts";

const bucket = (costUsd: number, input: number): UsageBucket => ({
  period: "2026-09-30",
  driver: "claude",
  model: "claude-opus",
  tokens: { input, output: 0, cacheRead: 0, cacheCreate: 0 },
  costUsd,
  priced: true,
  turns: 1,
});

const report = (over: Partial<UsageReport>): UsageReport => ({
  sinceMs: 0,
  untilMs: 1,
  resolution: "day",
  timeZone: "UTC",
  buckets: [],
  sources: [],
  pricing: "fresh",
  sessions: 0,
  readAt: 10,
  ...over,
});

const here: HostUsage = { hostId: "local", name: "This computer", loading: false, report: report({ buckets: [bucket(2, 100)], sessions: 3 }) };
const studio: HostUsage = { hostId: "host_studio", name: "studio", loading: false, report: report({ buckets: [bucket(5, 400)], sessions: 1, pricing: "cached", readAt: 4 }) };
const away: HostUsage = { hostId: "host_away", name: "away", loading: false, error: "The cockpit cannot reach away." };

describe("combining hosts' reports", () => {
  test("adds every answered host's buckets and sessions, and keeps the weakest pricing", () => {
    const all = combineReports([here.report!, studio.report!])!;
    expect(all.buckets.map((entry) => entry.costUsd)).toEqual([2, 5]);
    expect(all.sessions).toBe(4);
    expect(all.pricing).toBe("cached");
    expect(all.readAt).toBe(4);
  });

  test("an unreachable host is left out of the total instead of blocking it", () => {
    expect(reportFor([here, studio, away], ALL_HOSTS)!.sessions).toBe(4);
    expect(reportFor([here, away], ALL_HOSTS)).toBe(here.report);
  });

  test("choosing a host shows only that host", () => {
    expect(reportFor([here, studio], "host_studio")).toBe(studio.report);
    expect(reportFor([here, away], "host_away")).toBeUndefined();
  });

  test("each host's row carries its own totals, and an unreachable one says so", () => {
    expect(hostRows([here, studio, away])).toEqual([
      { hostId: "local", name: "This computer", costUsd: 2, processed: 100, sessions: 3, loading: false },
      { hostId: "host_studio", name: "studio", costUsd: 5, processed: 400, sessions: 1, loading: false },
      { hostId: "host_away", name: "away", costUsd: 0, processed: 0, sessions: 0, loading: false, error: "The cockpit cannot reach away." },
    ]);
  });
});
