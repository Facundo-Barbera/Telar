// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { UsageBucket, UsageReport } from "@telar/engine-client";
import { foldUsage, formatTokens, formatUsd, windowPeriods } from "./usage-report";

function bucket(overrides: Partial<UsageBucket>): UsageBucket {
  return {
    period: "2026-08-30",
    driver: "claude",
    model: "sonnet",
    tokens: { input: 10, output: 20, cacheRead: 70, cacheCreate: 0 },
    costUsd: 1,
    priced: true,
    turns: 1,
    ...overrides,
  };
}

function report(buckets: UsageBucket[], overrides: Partial<UsageReport> = {}): UsageReport {
  return {
    sinceMs: Date.UTC(2026, 7, 29),
    untilMs: Date.UTC(2026, 7, 31),
    resolution: "day",
    timeZone: "UTC",
    buckets,
    sources: [],
    pricing: "fresh",
    sessions: 2,
    readAt: 0,
    ...overrides,
  };
}

test("the window enumerates every period, empty ones included", () => {
  const days = windowPeriods(report([]));
  expect(days[0]).toBe("2026-08-29");
  expect(days).toContain("2026-08-30");
  expect(days.at(-1)).toBe("2026-08-31");
  const hours = windowPeriods(report([], { resolution: "hour", sinceMs: 0, untilMs: 3 * 3_600_000 }));
  expect(hours).toEqual(["0", "3600000", "7200000"]);
});

describe("foldUsage", () => {
  test("totals, provider split and shares-of-processed-tokens", () => {
    const fold = foldUsage(
      report([
        bucket({}),
        bucket({ driver: "codex", model: "gpt-5", costUsd: 0, priced: false, tokens: { input: 100, output: 200, cacheRead: 0, cacheCreate: 0 } }),
      ]),
    );
    expect(fold.total.processed).toBe(100 + 300);
    expect(fold.total.costUsd).toBe(1);
    // One unpriced provider makes the TOTAL unpriced — the figure says it is partial.
    expect(fold.total.priced).toBe(false);
    const claude = fold.providers.find((provider) => provider.driver === "claude")!;
    const codex = fold.providers.find((provider) => provider.driver === "codex")!;
    expect(claude.priced).toBe(true);
    expect(codex.priced).toBe(false);
    expect(claude.share + codex.share).toBeCloseTo(1);
    expect(codex.share).toBeCloseTo(300 / 400);
  });

  test("periods carry per-driver slices and quiet days stay present", () => {
    const fold = foldUsage(report([bucket({ period: "2026-08-30" })]));
    const quiet = fold.periods.find((period) => period.period === "2026-08-29")!;
    expect(quiet.total.turns).toBe(0);
    const busy = fold.periods.find((period) => period.period === "2026-08-30")!;
    expect(busy.byDriver.claude?.costUsd).toBe(1);
    expect(busy.byDriver.codex).toBeUndefined();
  });

  test("models sort by processed tokens, descending", () => {
    const fold = foldUsage(
      report([
        bucket({ model: "small", tokens: { input: 1, output: 1, cacheRead: 0, cacheCreate: 0 } }),
        bucket({ model: "big", tokens: { input: 1000, output: 0, cacheRead: 0, cacheCreate: 0 } }),
      ]),
    );
    expect(fold.models.map((model) => model.model)).toEqual(["big", "small"]);
  });
});

test("figures format compactly and honestly", () => {
  expect(formatUsd(1.005)).toBe("$1.00");
  expect(formatTokens(999)).toBe("999");
  expect(formatTokens(12_345)).toBe("12.3K");
  expect(formatTokens(4_560_000)).toBe("4.56M");
});
