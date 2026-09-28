/**
 * WHAT A SCHEDULE ROW SAYS ABOUT ITSELF — issue #543. Moved with the helpers
 * when the Settings pane left for the session's masthead.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { Schedule } from "@telar/engine-client";
import { inZone, lastRunSentence, ruleLabel } from "./schedules";

const row = (over: Partial<Schedule> = {}): Schedule => ({
  id: "sched_1",
  sessionId: "session_one",
  prompt: "daily digest",
  rule: { kind: "fixed", hour: 9, minute: 0, weekdays: [] },
  zone: "Europe/Madrid",
  enabled: true,
  createdAt: Date.UTC(2026, 4, 1, 0, 0, 0),
  nextRunAt: Date.UTC(2026, 5, 2, 7, 0, 0),
  ...over,
});

describe("the row's own zone", () => {
  test("an instant is rendered in the ROW's zone, not this machine's", () => {
    const at = Date.UTC(2026, 5, 2, 7, 0, 0);
    const original = process.env.TZ;
    try {
      process.env.TZ = "America/Los_Angeles";
      const fromLA = inZone(at, "Europe/Madrid");
      process.env.TZ = "Asia/Tokyo";
      const fromTokyo = inZone(at, "Europe/Madrid");
      expect(fromLA).toBe(fromTokyo);
      // 07:00 UTC is 09:00 in Madrid in June.
      expect(fromLA).toContain("09:00");
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  test("a zone this machine does not know renders something rather than blanking", () => {
    expect(inZone(Date.UTC(2026, 5, 2, 7, 0, 0), "Mars/Olympus").length).toBeGreaterThan(0);
  });
});

describe("what the row says about its last run", () => {
  test("a SKIPPED run names the instant that was missed, and why", () => {
    const sentence = lastRunSentence(row({ lastRunStatus: "skipped", lastSkippedAt: Date.UTC(2026, 5, 1, 7, 0, 0) }))!;
    expect(sentence).toContain("Skipped");
    expect(sentence).toContain("09:00");
    expect(sentence).toContain("Telar was closed");
  });

  test("a row that has never run says nothing", () => {
    expect(lastRunSentence(row())).toBeUndefined();
    expect(lastRunSentence(row({ lastRunStatus: "fired", lastRunAt: Date.UTC(2026, 5, 1, 7, 0, 0) }))).toContain("Last ran");
  });
});

describe("what the row fires on, in words", () => {
  test("an interval reads in the largest unit that divides it", () => {
    expect(ruleLabel({ kind: "interval", everyMs: 60_000 })).toBe("Every 1 minute");
    expect(ruleLabel({ kind: "interval", everyMs: 90 * 60_000 })).toBe("Every 90 minutes");
    expect(ruleLabel({ kind: "interval", everyMs: 3_600_000 })).toBe("Every 1 hour");
    expect(ruleLabel({ kind: "interval", everyMs: 86_400_000 })).toBe("Every 1 day");
  });

  test("an empty weekday set is every day, and the five are 'every weekday'", () => {
    expect(ruleLabel({ kind: "fixed", hour: 9, minute: 0, weekdays: [] })).toBe("Every day at 09:00");
    expect(ruleLabel({ kind: "fixed", hour: 9, minute: 5, weekdays: [1, 2, 3, 4, 5] })).toBe("Every weekday at 09:05");
    expect(ruleLabel({ kind: "fixed", hour: 18, minute: 30, weekdays: [1, 4] })).toBe("Mon, Thu at 18:30");
  });
});
