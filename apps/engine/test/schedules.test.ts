/**
 * WHEN A SCHEDULE FIRES — issue #543, the pure half.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * NO STORE, NO CLOCK, NO TIMER. Every assertion here is two numbers in and one
 * number out, which is why most of this feature's tests point at this file
 * rather than at the sweep.
 *
 * THE DST ASSERTIONS COMPARE LOCAL WALL-CLOCK STRINGS, not instants, and that
 * is the whole trick. `expect(next).toBeGreaterThan(now)` passes against an
 * implementation that adds 86 400 000 ms and lands an hour off — the broken
 * version this function exists to avoid. Formatting the answer back into the
 * zone is what makes the assertion able to fail.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { describe, expect, test } from "bun:test";
import { decideSchedule, nextOccurrence, SCHEDULE_GRACE_MS, usableZone, type ScheduleRule } from "../src/schedules";

/** An instant as it reads on a wall clock in `zone` — the form every assertion
 *  below compares, because it is the form a person would dispute. */
const localOf = (zone: string, at: number): string =>
  new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .format(new Date(at))
    .replace(",", "");

const daily = (hour: number, minute: number, weekdays: readonly number[] = []): ScheduleRule => ({ kind: "fixed", hour, minute, weekdays });

describe("the next occurrence, in the row's own calendar (#543)", () => {
  test("a daily rule lands on the same local wall clock across SPRING FORWARD", () => {
    /**
     * Europe/Madrid jumps 02:00 → 03:00 on 2026-03-29. A 09:00 rule must read
     * 09:00 on the 28th, the 29th and the 30th — the day after the boundary is
     * where `+ 86_400_000` renders 10:00 and this fails.
     */
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
    // Madrid repeats 03:00 → 02:00 on 2026-10-25, the other direction of the
    // same error.
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
    /**
     * 02:30 does not exist in Madrid on 2026-03-29. The decision recorded in
     * `schedules.ts` is to fire at the jump: skipping would silently drop one
     * occurrence a year for anybody whose time sits in the lost hour, and a run
     * that happened is easier to explain than one that did not.
     */
    const zone = "Europe/Madrid";
    const eve = Date.UTC(2026, 2, 28, 12, 0, 0);
    const next = nextOccurrence(daily(2, 30), zone, eve);
    // The 29th, and rendered at the jump — 03:00 local, not 02:30, which does
    // not exist. What matters is that it is ON the 29th and did not skip a day.
    expect(localOf(zone, next).startsWith("29/03/2026")).toBe(true);
    expect(next).toBeGreaterThan(eve);
  });

  test("a time that happens TWICE on fall-back yields ONE occurrence, not two", () => {
    // 02:30 reads twice in Madrid on 2026-10-25. Asking repeatedly must walk to
    // the 26th rather than returning the second reading of the 25th.
    const zone = "Europe/Madrid";
    const first = nextOccurrence(daily(2, 30), zone, Date.UTC(2026, 9, 24, 12, 0, 0));
    const second = nextOccurrence(daily(2, 30), zone, first);
    expect(localOf(zone, first).startsWith("25/10/2026")).toBe(true);
    expect(localOf(zone, second).startsWith("26/10/2026")).toBe(true);
  });

  test("THE ZONE IS THE ROW'S, not the machine's", () => {
    /**
     * A row created in Tokyo keeps firing at Tokyo's 09:00 after the laptop
     * flies anywhere. Driven by evaluating under two different `TZ` values —
     * the assertion is that they are EQUAL, which `new Date().getHours()` could
     * not satisfy.
     */
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
    // Monday only, asked on a Wednesday: the following Monday.
    const wednesday = Date.UTC(2026, 5, 3, 12, 0, 0);
    expect(localOf(zone, nextOccurrence(daily(9, 0, [1]), zone, wednesday))).toBe("08/06/2026 09:00");
    // ...and with no weekday set at all, tomorrow.
    expect(localOf(zone, nextOccurrence(daily(9, 0), zone, wednesday))).toBe("04/06/2026 09:00");
  });

  test("an unknown zone degrades to UTC rather than throwing", () => {
    // A row is DURABLE: a zone valid when it was written and not after an OS
    // update must keep the row firing, an hour or two off, rather than turning
    // one bad row into a sweep that throws.
    expect(usableZone("Mars/Olympus")).toBe("UTC");
    expect(usableZone("Asia/Tokyo")).toBe("Asia/Tokyo");
    const at = Date.UTC(2026, 5, 3, 12, 0, 0);
    expect(() => nextOccurrence(daily(9, 0), "Mars/Olympus", at)).not.toThrow();
    expect(localOf("UTC", nextOccurrence(daily(9, 0), "Mars/Olympus", at))).toBe("04/06/2026 09:00");
  });
});

describe("what a due row does about being late (#543)", () => {
  test("A THREE-DAY GAP PRODUCES ONE RUN, and re-aims past now", () => {
    /**
     * THE HEADLINE FAILURE THIS ISSUE IS ABOUT. An hourly row, a clock that
     * jumped 72 hours: re-aiming as `dueAt + everyMs` once would leave the row
     * still due and produce one turn per missed hour on the next pass.
     */
    const everyMs = 3_600_000;
    const dueAt = Date.UTC(2026, 5, 1, 9, 0, 0);
    const now = dueAt + 72 * 3_600_000;
    const decision = decideSchedule({ kind: "interval", everyMs }, "UTC", dueAt, now);
    expect(decision.fire).toBe(true);
    // STRICTLY in the future, and within one interval of it — the two halves
    // that together mean "advanced past now in whole intervals".
    expect(decision.nextRunAt).toBeGreaterThan(now);
    expect(decision.nextRunAt).toBeLessThanOrEqual(now + everyMs);
    // ...and still on the original phase, which `now + everyMs` would lose.
    expect((decision.nextRunAt - dueAt) % everyMs).toBe(0);
  });

  test("and the re-aimed row STAYS in the future across further sweeps", () => {
    // The anti-vacuity half of the test above: drop the `while` loop and the
    // second sweep fires again.
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
    /**
     * BOTH DIRECTIONS, because each alone is worthless: a suite with only the
     * skip case passes against a scheduler that never fires at all, and one
     * with only the fire case passes against one that fires everything late.
     */
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
    // "Every hour" has no wall clock to miss — the next hour is simply the next
    // hour — so a long gap advances it rather than skipping it.
    const decision = decideSchedule({ kind: "interval", everyMs: 3_600_000 }, "UTC", 0, 72 * 3_600_000);
    expect(decision.fire).toBe(true);
    expect(decision.skipped).toBeUndefined();
  });
});
