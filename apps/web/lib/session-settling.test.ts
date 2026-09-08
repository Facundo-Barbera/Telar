// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { SettleableSession } from "./session-settling";
import {
  canSettle,
  canSnooze,
  hasUnreadResult,
  isSettled,
  isSnoozed,
  raisedHandWhileSnoozed,
  snoozePresets,
  wakeLabel,
  wokeAt,
} from "./session-settling";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

const session = (over: Partial<SettleableSession> = {}): SettleableSession => ({
  archived: false,
  updatedAt: NOW,
  ...over,
});

// The contract owns the default and the 1..90 bound, because the engine
// validates against them; this module takes the window as an argument and has
// no opinion about which one is usual.
const options = { now: NOW, autoSettleAfterHours: 72 };

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
    const off = { now: NOW, autoSettleAfterHours: null };
    expect(isSettled(session({ updatedAt: NOW - 400 * DAY }), {}, off)).toBe(false);
    // A decision still settles it.
    expect(isSettled(session({ updatedAt: NOW, settledOverride: "settled" }), {}, off)).toBe(true);
  });

  test("the window is configurable, not the constant it used to be", () => {
    const week = { now: NOW, autoSettleAfterHours: 168 };
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

describe("an unread answer is never shelved by the clock", () => {
  const HOUR = 60 * 60 * 1000;
  // The reported case: three hours configured, and a session that answered
  // four hours ago with nobody having looked at it.
  const threeHours = { now: NOW, autoSettleAfterHours: 3 };
  const unread = session({ updatedAt: NOW - 4 * HOUR, lastTurnSequence: 7 });

  test("unread is the two sequences, not a clock", () => {
    expect(hasUnreadResult(unread)).toBe(true);
    expect(hasUnreadResult(session({ lastTurnSequence: 7, lastReadTurnSequence: 7 }))).toBe(false);
    expect(hasUnreadResult(session({ lastTurnSequence: 8, lastReadTurnSequence: 7 }))).toBe(true);
  });

  test("a session with no result at all has nothing to read", () => {
    // Absent means "never answered", not "unknown" — see `hasUnreadResult`.
    expect(hasUnreadResult(session())).toBe(false);
    expect(isSettled(session({ updatedAt: NOW - 4 * HOUR }), {}, threeHours)).toBe(true);
  });

  test("the inactivity window does not hide it", () => {
    expect(isSettled(unread, {}, threeHours)).toBe(false);
  });

  test("…and reading it hands the session back to the clock", () => {
    const read = { ...unread, lastReadTurnSequence: 7, readAt: NOW - 4 * HOUR };
    expect(isSettled(read, {}, threeHours)).toBe(true);
    // Read a moment ago: the window runs from the read, not from the work.
    expect(isSettled({ ...read, readAt: NOW - HOUR }, {}, threeHours)).toBe(false);
  });

  test("a NEWER answer makes a read session unread again", () => {
    expect(isSettled({ ...unread, lastTurnSequence: 8, lastReadTurnSequence: 7 }, {}, threeHours)).toBe(false);
  });

  test("but an explicit settle still shelves it — a human said so", () => {
    // Manual settling, and settling by an agent, both go through the override.
    expect(isSettled({ ...unread, settledOverride: "settled" }, {}, threeHours)).toBe(true);
    // And it is still the pin, not the clock: with the clock off, same answer.
    expect(isSettled({ ...unread, settledOverride: "settled" }, {}, { now: NOW, autoSettleAfterHours: null })).toBe(true);
  });

  test("an archived session is shelved whether or not anyone read it", () => {
    expect(isSettled({ ...unread, archived: true }, {}, threeHours)).toBe(true);
  });

  test("a blocker still outranks it in the other direction", () => {
    // Unread keeps a row visible; a parked request keeps it visible too. The
    // interesting case is that neither turns into a settle.
    expect(isSettled(unread, { waitingOnYou: true }, threeHours)).toBe(false);
    expect(isSettled(unread, { working: true }, threeHours)).toBe(false);
  });
});

describe("a snooze outlives a shorter auto-settle window", () => {
  const HOUR = 60 * 60 * 1000;
  const threeHours = { now: NOW, autoSettleAfterHours: 3 };
  // "Tomorrow at 9", set last night, on a machine that shelves after 3h.
  const tomorrow = session({ updatedAt: NOW - 10 * HOUR, snoozedAt: NOW - 10 * HOUR, snoozedUntil: NOW + 6 * HOUR });

  test("the clock cannot shelve a session that is still asleep", () => {
    expect(isSettled(tomorrow, {}, threeHours)).toBe(false);
    // And it is genuinely hidden meanwhile — by the snooze, which is the band
    // that can wake it, rather than by the shelf, which cannot.
    expect(isSnoozed(tomorrow, {}, { now: NOW })).toBe(true);
  });

  test("waking gives it a full window to be noticed, not an instant shelf", () => {
    const justWoke = { now: NOW + 6 * HOUR + 60_000, autoSettleAfterHours: 3 };
    expect(isSnoozed(tomorrow, {}, justWoke)).toBe(false);
    expect(isSettled(tomorrow, {}, justWoke)).toBe(false);
    // Three hours after the WAKE, with nothing else happening, it shelves.
    expect(isSettled(tomorrow, {}, { now: NOW + 6 * HOUR + 3 * HOUR + 1, autoSettleAfterHours: 3 })).toBe(true);
  });

  test("a malformed wake time is ignored by the baseline too", () => {
    const broken = session({ updatedAt: NOW - 10 * HOUR, snoozedUntil: Number.NaN });
    expect(isSettled(broken, {}, threeHours)).toBe(true);
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
