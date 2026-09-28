import { describe, expect, test } from "bun:test";
import { passesOver, pollDelay } from "./worker";
import { ACTIVITY_REFRESH_S, ACTIVITY_STALE_S } from "./push";

describe("the cadence the feed buys (#586)", () => {
  test("WITHOUT the feed, ten minutes costs sixty wide passes", () => {
    expect(pollDelay(false)).toBe(10_000);
    expect(passesOver(10, false)).toBe(60);
    expect(passesOver(60, false)).toBe(360);
  });

  test("WITH the feed, the same ten minutes costs ONE", () => {
    expect(pollDelay(true)).toBe(600_000);
    expect(passesOver(10, true)).toBe(1);
    expect(passesOver(60, true)).toBe(6);
  });

  test("a Live Activity waiting on a quiet session keeps the timer at the heartbeat", () => {
    expect(pollDelay(true, true)).toBe(ACTIVITY_REFRESH_S * 1000);
    expect(pollDelay(true, true)).toBeLessThan(ACTIVITY_STALE_S * 1000);
    expect(pollDelay(false, true)).toBe(10_000);
  });

  test("the reconcile is NOT removed, which is what makes the feed safe to trust", () => {
    expect(passesOver(60, true)).toBeGreaterThan(0);
    expect(passesOver(60, true)).toBeLessThan(passesOver(60, false));
  });
});
