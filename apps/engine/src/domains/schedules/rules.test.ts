import { describe, expect, test } from "bun:test";
import { decideSchedule, nextOccurrence, SCHEDULE_GRACE_MS, usableZone, type ScheduleRule } from "./rules";

const localOf = (zone: string, at: number): string =>
  new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .format(new Date(at))
    .replace(",", "");

const daily = (hour: number, minute: number, weekdays: readonly number[] = []): ScheduleRule => ({ kind: "fixed", hour, minute, weekdays });

describe("the next occurrence, in the row's own calendar (#543)", () => {
  test("a daily rule lands on the same local wall clock across SPRING FORWARD", () => {
    const zone = "Europe/Madrid";
    let at = Date.UTC(2026, 2, 27, 12, 0, 0);
    const seen: string[] = [];
    for (let day = 0; day < 4; day += 1) {
      at = nextOccurrence(daily(9, 0), zone, at);
      seen.push(localOf(zone, at));
    }
    expect(seen).toEqual(["28/03/2026 09:00", "29/03/2026 09:00", "30/03/2026 09:00", "31/03/2026 09:00"]);
  });

  test("a daily rule lands on the same local wall clock across FALL BACK", () => {
    const zone = "Europe/Madrid";
    let at = Date.UTC(2026, 9, 23, 12, 0, 0);
    const seen: string[] = [];
    for (let day = 0; day < 4; day += 1) {
      at = nextOccurrence(daily(9, 0), zone, at);
      seen.push(localOf(zone, at));
    }
    expect(seen).toEqual(["24/10/2026 09:00", "25/10/2026 09:00", "26/10/2026 09:00", "27/10/2026 09:00"]);
  });

  test("a time inside the LOST HOUR fires at the jump rather than vanishing", () => {
    const zone = "Europe/Madrid";
    const eve = Date.UTC(2026, 2, 28, 12, 0, 0);
    const next = nextOccurrence(daily(2, 30), zone, eve);
    expect(localOf(zone, next).startsWith("29/03/2026")).toBe(true);
    expect(next).toBeGreaterThan(eve);
  });

  test("a time that happens TWICE on fall-back yields ONE occurrence, not two", () => {
    const zone = "Europe/Madrid";
    const first = nextOccurrence(daily(2, 30), zone, Date.UTC(2026, 9, 24, 12, 0, 0));
    const second = nextOccurrence(daily(2, 30), zone, first);
    expect(localOf(zone, first).startsWith("25/10/2026")).toBe(true);
    expect(localOf(zone, second).startsWith("26/10/2026")).toBe(true);
  });

  test("THE ZONE IS THE ROW'S, not the machine's", () => {
    const at = Date.UTC(2026, 5, 1, 0, 0, 0);
    const original = process.env.TZ;
    try {
      process.env.TZ = "America/Los_Angeles";
      const fromLA = nextOccurrence(daily(9, 0), "Asia/Tokyo", at);
      process.env.TZ = "Europe/Madrid";
      const fromMadrid = nextOccurrence(daily(9, 0), "Asia/Tokyo", at);
      expect(fromLA).toBe(fromMadrid);
      expect(localOf("Asia/Tokyo", fromLA).endsWith("09:00")).toBe(true);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  test("weekdays are honoured, and an empty set means every day", () => {
    const zone = "UTC";
    const wednesday = Date.UTC(2026, 5, 3, 12, 0, 0);
    expect(localOf(zone, nextOccurrence(daily(9, 0, [1]), zone, wednesday))).toBe("08/06/2026 09:00");
    expect(localOf(zone, nextOccurrence(daily(9, 0), zone, wednesday))).toBe("04/06/2026 09:00");
  });

  test("an unknown zone degrades to UTC rather than throwing", () => {
    expect(usableZone("Mars/Olympus")).toBe("UTC");
    expect(usableZone("Asia/Tokyo")).toBe("Asia/Tokyo");
    const at = Date.UTC(2026, 5, 3, 12, 0, 0);
    expect(() => nextOccurrence(daily(9, 0), "Mars/Olympus", at)).not.toThrow();
    expect(localOf("UTC", nextOccurrence(daily(9, 0), "Mars/Olympus", at))).toBe("04/06/2026 09:00");
  });
});

describe("what a due row does about being late (#543)", () => {
  test("A THREE-DAY GAP PRODUCES ONE RUN, and re-aims past now", () => {
    const everyMs = 3_600_000;
    const dueAt = Date.UTC(2026, 5, 1, 9, 0, 0);
    const now = dueAt + 72 * 3_600_000;
    const decision = decideSchedule({ kind: "interval", everyMs }, "UTC", dueAt, now);
    expect(decision.fire).toBe(true);
    expect(decision.nextRunAt).toBeGreaterThan(now);
    expect(decision.nextRunAt).toBeLessThanOrEqual(now + everyMs);
    expect((decision.nextRunAt - dueAt) % everyMs).toBe(0);
  });

  test("and the re-aimed row STAYS in the future across further sweeps", () => {
    const everyMs = 3_600_000;
    let dueAt = Date.UTC(2026, 5, 1, 9, 0, 0);
    const now = dueAt + 72 * 3_600_000;
    let fires = 0;
    for (let sweep = 0; sweep < 5; sweep += 1) {
      if (dueAt > now) continue;
      const decision = decideSchedule({ kind: "interval", everyMs }, "UTC", dueAt, now);
      if (decision.fire) fires += 1;
      dueAt = decision.nextRunAt;
    }
    expect(fires).toBe(1);
  });

  test("a LONG-MISSED fixed time is skipped; a JUST-MISSED one still fires", () => {
    const zone = "UTC";
    const dueAt = Date.UTC(2026, 5, 1, 9, 0, 0);

    const missed = decideSchedule(daily(9, 0), zone, dueAt, dueAt + 7 * 3_600_000);
    expect(missed.fire).toBe(false);
    expect(missed.skipped).toBe(dueAt);
    expect(missed.nextRunAt).toBeGreaterThan(dueAt + 7 * 3_600_000);

    const justMissed = decideSchedule(daily(9, 0), zone, dueAt, dueAt + 30_000);
    expect(justMissed.fire).toBe(true);
    expect(justMissed.skipped).toBeUndefined();
  });

  test("the grace is a boundary, asserted on both sides of itself", () => {
    const zone = "UTC";
    const dueAt = Date.UTC(2026, 5, 1, 9, 0, 0);
    expect(decideSchedule(daily(9, 0), zone, dueAt, dueAt + SCHEDULE_GRACE_MS).fire).toBe(true);
    expect(decideSchedule(daily(9, 0), zone, dueAt, dueAt + SCHEDULE_GRACE_MS + 1).fire).toBe(false);
  });

  test("an INTERVAL row has no grace, because it has no appointment to be late for", () => {
    const decision = decideSchedule({ kind: "interval", everyMs: 3_600_000 }, "UTC", 0, 72 * 3_600_000);
    expect(decision.fire).toBe(true);
    expect(decision.skipped).toBeUndefined();
  });
});
