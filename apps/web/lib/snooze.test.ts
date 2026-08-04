// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { SNOOZE_PRESETS, snoozePresetsFor } from "./snooze";

const at = (id: string, now: Date) => {
  const preset = SNOOZE_PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error(`no preset ${id}`);
  return new Date(preset.at(now));
};

// A Wednesday, mid-afternoon, in whatever zone the test host runs in — every
// preset is local-time by design, so the assertions read local fields too.
const WED_2PM = new Date(2026, 7, 5, 14, 0, 0, 0);

describe("snooze presets", () => {
  test("an hour is an hour", () => {
    expect(at("hour", WED_2PM).getTime() - WED_2PM.getTime()).toBe(60 * 60 * 1000);
  });

  test("tomorrow morning is 9am on the next calendar day", () => {
    const result = at("tomorrow", WED_2PM);
    expect(result.getDate()).toBe(6);
    expect(result.getHours()).toBe(9);
    expect(result.getMinutes()).toBe(0);
  });

  test("next Monday never resolves to today", () => {
    const monday = new Date(2026, 7, 3, 14, 0, 0, 0);
    expect(monday.getDay()).toBe(1);
    const result = at("monday", monday);
    expect(result.getDay()).toBe(1);
    expect(result.getDate()).toBe(10);
  });

  test("next Monday from a Sunday is the very next day", () => {
    const sunday = new Date(2026, 7, 2, 14, 0, 0, 0);
    expect(sunday.getDay()).toBe(0);
    expect(at("monday", sunday).getDate()).toBe(3);
  });

  test("day arithmetic is calendar-based, not +86400000", () => {
    // Whatever the host zone's DST rules, landing on the named hour is the
    // property that matters — a millisecond offset would drift by an hour
    // across a transition.
    for (const day of [1, 8, 15, 60, 120, 240]) {
      const from = new Date(2026, 0, day, 14, 0, 0, 0);
      expect(at("tomorrow", from).getHours()).toBe(9);
      expect(at("monday", from).getHours()).toBe(9);
    }
  });

  test("presets already in the past are not offered", () => {
    const lateEvening = new Date(2026, 7, 5, 23, 30, 0, 0);
    const ids = snoozePresetsFor(lateEvening).map((p) => p.id);
    expect(ids).not.toContain("evening");
    expect(ids).toContain("hour");
    expect(ids).toContain("tomorrow");
  });

  test("every offered preset resolves to the future", () => {
    for (const hour of [0, 6, 9, 13, 17, 18, 21, 23]) {
      const now = new Date(2026, 7, 5, hour, 0, 0, 0);
      for (const preset of snoozePresetsFor(now)) {
        expect(preset.at(now)).toBeGreaterThan(now.getTime());
      }
    }
  });
});
