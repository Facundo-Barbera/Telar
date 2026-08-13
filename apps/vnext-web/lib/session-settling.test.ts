// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { SettleableSession } from "./session-settling";
import {
  canSettle,
  canSnooze,
  isSettled,
  isSnoozed,
  raisedHandWhileSnoozed,
  snoozePresets,
  wakeLabel,
  wokeAt,
  DEFAULT_AUTO_SETTLE_DAYS,
} from "./session-settling";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

const session = (over: Partial<SettleableSession> = {}): SettleableSession => ({
  archived: false,
  updatedAt: NOW,
  ...over,
});

const options = { now: NOW, autoSettleAfterDays: DEFAULT_AUTO_SETTLE_DAYS };

describe("blockers beat everything", () => {
  test("a session waiting on a human is never settled, even when explicitly settled", () => {
    // THE ORDERING THAT MAKES THIS SAFE: the worst outcome of a settling system
    // is hiding the one row that needed you.
    expect(isSettled(session({ settledOverride: "settled" }), { waitingOnYou: true }, options)).toBe(false);
  });

  test("a running turn holds a session in the list", () => {
    expect(isSettled(session({ settledOverride: "settled" }), { working: true }, options)).toBe(false);
  });

  test("neither can be settled or, for a parked request, snoozed", () => {
    // A running session IS snoozable: snooze changes what you are shown, not
    // what the agent does.
    expect(canSettle({ working: true })).toBe(false);
    expect(canSettle({ waitingOnYou: true })).toBe(false);
    expect(canSnooze({ working: true })).toBe(true);
    expect(canSnooze({ waitingOnYou: true })).toBe(false);
  });

  test("a quiet session that is blocked stays visible past the auto-settle window", () => {
    const stale = session({ updatedAt: NOW - 30 * DAY });
    expect(isSettled(stale, {}, options)).toBe(true);
    expect(isSettled(stale, { waitingOnYou: true }, options)).toBe(false);
  });
});

describe("the explicit pin", () => {
  test("settles a session the clock would have kept", () => {
    expect(isSettled(session({ updatedAt: NOW }), {}, options)).toBe(false);
    expect(isSettled(session({ updatedAt: NOW, settledOverride: "settled" }), {}, options)).toBe(true);
  });

  test("keeps a session the clock would have shelved", () => {
    // The third answer neither a boolean nor an absence can express.
    const stale = { updatedAt: NOW - 30 * DAY };
    expect(isSettled(session(stale), {}, options)).toBe(true);
    expect(isSettled(session({ ...stale, settledOverride: "active" }), {}, options)).toBe(false);
  });

  test("archiving outranks a pin to keep it active", () => {
    // Archived is a decision about the conversation, not about the list.
    expect(isSettled(session({ archived: true, settledOverride: "active" }), {}, options)).toBe(true);
  });
});

describe("the clock", () => {
  test("shelves a session quiet for longer than the window", () => {
    expect(isSettled(session({ updatedAt: NOW - 4 * DAY }), {}, options)).toBe(true);
    expect(isSettled(session({ updatedAt: NOW - 2 * DAY }), {}, options)).toBe(false);
  });

  test("turning it off means nothing settles by neglect", () => {
    const off = { now: NOW, autoSettleAfterDays: null };
    expect(isSettled(session({ updatedAt: NOW - 400 * DAY }), {}, off)).toBe(false);
    // A decision still settles it.
    expect(isSettled(session({ updatedAt: NOW, settledOverride: "settled" }), {}, off)).toBe(true);
  });

  test("the window is configurable, not the constant it used to be", () => {
    const week = { now: NOW, autoSettleAfterDays: 7 };
    expect(isSettled(session({ updatedAt: NOW - 4 * DAY }), {}, week)).toBe(false);
    expect(isSettled(session({ updatedAt: NOW - 8 * DAY }), {}, week)).toBe(true);
  });
});

describe("snoozing", () => {
  const snoozed = session({ snoozedUntil: NOW + 2 * 60 * 60 * 1000, snoozedAt: NOW - 60_000 });

  test("hides a session until its wake time", () => {
    expect(isSnoozed(snoozed, {}, { now: NOW })).toBe(true);
    expect(isSnoozed(snoozed, {}, { now: NOW + 3 * 60 * 60 * 1000 })).toBe(false);
  });

  test("a parked request raises its hand immediately", () => {
    expect(isSnoozed(snoozed, { waitingOnYou: true }, { now: NOW })).toBe(false);
    expect(raisedHandWhileSnoozed(snoozed, { waitingOnYou: true })).toBe(true);
  });

  test("work finishing AFTER the snooze wakes it; work that finished before does not", () => {
    expect(isSnoozed(snoozed, { lastTurnEndedAt: NOW - 30_000 }, { now: NOW })).toBe(false);
    expect(isSnoozed(snoozed, { lastTurnEndedAt: NOW - 120_000 }, { now: NOW })).toBe(true);
  });

  test("only a FRESH failure wakes it", () => {
    // A session snoozed while already failed stays snoozed — that snooze was
    // the reader saying "I saw it, not now".
    expect(isSnoozed(snoozed, { failed: true, failedAt: NOW - 120_000 }, { now: NOW })).toBe(true);
    expect(isSnoozed(snoozed, { failed: true, failedAt: NOW - 10_000 }, { now: NOW })).toBe(false);
  });

  test("a malformed wake time never hides anything", () => {
    expect(isSnoozed(session({ snoozedUntil: Number.NaN }), {}, { now: NOW })).toBe(false);
  });

  test("waking reports WHEN, so a static list can still signal it", () => {
    expect(wokeAt(snoozed, {}, { now: NOW })).toBeUndefined();
    expect(wokeAt(snoozed, {}, { now: NOW + 3 * 60 * 60 * 1000 })).toBe(snoozed.snoozedUntil);
    // An early wake stays authoritative once the scheduled time passes, or it
    // would resurface a signal the reader already dealt with.
    expect(wokeAt(snoozed, { lastTurnEndedAt: NOW - 30_000 }, { now: NOW + 3 * 60 * 60 * 1000 })).toBe(NOW - 30_000);
  });

  test("a session that never slept never woke", () => {
    expect(wokeAt(session(), {}, { now: NOW })).toBeUndefined();
  });
});

describe("the snooze menu", () => {
  test("this evening disappears once it is nearly evening", () => {
    // A snooze that expires in four minutes is not a snooze.
    const midday = new Date(2026, 0, 5, 12, 0, 0);
    const lateAfternoon = new Date(2026, 0, 5, 17, 30, 0);
    expect(snoozePresets(midday).map((preset) => preset.id)).toContain("evening");
    expect(snoozePresets(lateAfternoon).map((preset) => preset.id)).not.toContain("evening");
  });

  test("tomorrow is 9am tomorrow, by calendar day", () => {
    const late = new Date(2026, 0, 5, 23, 30, 0);
    const tomorrow = snoozePresets(late).find((preset) => preset.id === "tomorrow");
    const woken = new Date(tomorrow!.until);
    // The DST trap: a fixed 24-hour offset skips a whole day on a 23-hour one.
    expect(woken.getDate()).toBe(6);
    expect(woken.getHours()).toBe(9);
  });

  test("next week from a Monday is the NEXT Monday, not today", () => {
    const monday = new Date(2026, 0, 5, 10, 0, 0);
    expect(monday.getDay()).toBe(1);
    const nextWeek = snoozePresets(monday).find((preset) => preset.id === "next-week");
    expect(new Date(nextWeek!.until).getDate()).toBe(12);
  });

  test("every preset wakes in the future", () => {
    const now = new Date(2026, 0, 5, 12, 0, 0);
    for (const preset of snoozePresets(now)) expect(preset.until).toBeGreaterThan(now.getTime());
  });
});

describe("how long is left", () => {
  test("rounds minutes up, so a live snooze never reads as zero", () => {
    expect(wakeLabel(NOW + 10_000, NOW)).toBe("1m");
    expect(wakeLabel(NOW + 90 * 60 * 1000, NOW)).toBe("2h");
    expect(wakeLabel(NOW + 50 * 60 * 60 * 1000, NOW)).toBe("3d");
  });

  test("a wake time already past reads as now", () => {
    expect(wakeLabel(NOW - 1, NOW)).toBe("now");
  });
});
