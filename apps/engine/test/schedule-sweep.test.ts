/**
 * A SCHEDULE THAT COMES DUE — issue #543, at the store.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * NO TEST HERE STARTS A TIMER. Every one calls `sweepSchedules()` directly on a
 * clock it winds by hand, which is what the three existing sweep suites do and
 * is the only way "a three-day gap" is a test rather than a three-day wait.
 * `snooze-wake.test.ts` is the template, including its `reopen()` helper.
 *
 * COUNTS, NEVER THE PRESENCE OF A STRING. "A turn was submitted" and
 * "72 turns were submitted" emit the same events; only the count tells them
 * apart, and the 72 is the bug this issue is about.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore } from "../src/state";

const homes: string[] = [];
const stores: EngineStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.closeExecutionStore();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

const START = Date.UTC(2026, 5, 1, 8, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-sched-"));
  homes.push(home);
  const clock = { now: START };
  const store = new EngineStore(home, () => clock.now, { executionStorage: "sqlite" });
  stores.push(store);
  store.registerProject({ id: "project_one", name: "test", root: "/tmp" });
  store.createSession({ id: "session_one", projectId: "project_one" });
  return { store, home, clock };
}

function reopen(home: string, now: number) {
  const store = new EngineStore(home, () => now, { executionStorage: "sqlite" });
  stores.push(store);
  return store;
}

/** Turns in the session, which is the number every assertion here is about. */
const turnCount = (store: EngineStore, sessionId = "session_one"): number => store.turns(sessionId).length;

test("A THREE-DAY GAP PRODUCES EXACTLY ONE TURN (#543)", () => {
  /**
   * THE HEADLINE. Re-aiming as `dueAt + everyMs` once would leave the row still
   * due and produce one turn per missed hour on the next pass — 72 of them, into
   * a conversation somebody opened after a long weekend.
   */
  const { store, clock } = setup();
  store.putSchedule({ sessionId: "session_one", prompt: "status?", rule: { kind: "interval", everyMs: HOUR }, zone: "UTC" });

  // NOTHING IS OWED YET. Without this the assertion below would pass against a
  // sweep that fires every row it is handed.
  expect(store.sweepSchedules()).toEqual([]);
  expect(turnCount(store)).toBe(0);

  clock.now = START + 72 * HOUR;
  expect(store.sweepSchedules()).toHaveLength(1);
  expect(turnCount(store)).toBe(1);

  // ...AND IT STAYS IN THE FUTURE. Four more sweeps across the next hour add
  // nothing, which is what "advanced past now" means and what dropping the
  // `while` loop would break.
  for (const minutes of [1, 15, 30, 59]) {
    clock.now = START + 72 * HOUR + minutes * MINUTE;
    store.sweepSchedules();
  }
  expect(turnCount(store)).toBe(1);

  // And the next hour does fire, or "stays in the future" would be satisfied by
  // a row that never fires again.
  clock.now = START + 73 * HOUR + MINUTE;
  store.sweepSchedules();
  expect(turnCount(store)).toBe(2);
});

test("a LONG-MISSED fixed time is skipped and says so; a JUST-MISSED one runs (#543)", () => {
  /**
   * BOTH DIRECTIONS IN ONE FILE. Only the skip case passes against a scheduler
   * that never fires; only the fire case passes against one that fires
   * everything late. The pair is the claim.
   */
  const { store, clock } = setup();
  const missed = store.putSchedule({
    sessionId: "session_one",
    prompt: "daily digest",
    rule: { kind: "fixed", hour: 9, minute: 0, weekdays: [] },
    zone: "UTC",
  });
  // Seven hours past 09:00 — Telar was not running at nine.
  clock.now = Date.UTC(2026, 5, 1, 16, 0, 0);
  expect(store.sweepSchedules()).toEqual([missed.id]);
  expect(turnCount(store)).toBe(0);
  const skipped = store.readSchedule(missed.id)!;
  expect(skipped.lastRunStatus).toBe("skipped");
  // THE INSTANT THAT WAS MISSED, which is what the settings surface renders as
  // a sentence — an absent number would make the boundary invisible.
  expect(skipped.lastSkippedAt).toBe(Date.UTC(2026, 5, 1, 9, 0, 0));
  expect(skipped.nextRunAt).toBeGreaterThan(clock.now);

  // The same shape, thirty seconds late, still runs.
  const { store: second, clock: secondClock } = setup();
  const fresh = second.putSchedule({
    sessionId: "session_one",
    prompt: "daily digest",
    rule: { kind: "fixed", hour: 9, minute: 0, weekdays: [] },
    zone: "UTC",
  });
  secondClock.now = Date.UTC(2026, 5, 1, 9, 0, 30);
  second.sweepSchedules();
  expect(turnCount(second)).toBe(1);
  expect(second.readSchedule(fresh.id)!.lastRunStatus).toBe("fired");
});

test("a fired turn is a SCHEDULE-origin turn that names its row (#543)", () => {
  // Widened rather than borrowed: a fake `sender` would put every scheduled
  // turn into the "who sent this" surfaces as a peer message.
  const { store, clock } = setup();
  const row = store.putSchedule({ sessionId: "session_one", prompt: "go", rule: { kind: "interval", everyMs: HOUR }, zone: "UTC" });
  clock.now = START + 2 * HOUR;
  store.sweepSchedules();

  const turn = store.turns("session_one")[0]!;
  expect(turn.origin).toBe("schedule");
  expect(turn.scheduleOrigin).toMatchObject({ scheduleId: row.id });
  expect(turn.sender).toBeUndefined();
  expect(turn.wakeReason).toBeUndefined();
  expect(turn.input).toBe("go");
});

test("a schedule survives a restart, and fires for the reader that comes back (#543)", () => {
  // Held in memory, nothing fires after reopen — which is the whole reason the
  // row is a sqlite table rather than a Map.
  const { store, home } = setup();
  store.putSchedule({ sessionId: "session_one", prompt: "after the restart", rule: { kind: "interval", everyMs: HOUR }, zone: "UTC" });
  store.closeExecutionStore();

  const later = reopen(home, START + 5 * HOUR);
  expect(later.sweepSchedules()).toHaveLength(1);
  expect(turnCount(later)).toBe(1);
});

test("a disabled row is not swept, and one bad row does not stop a good one (#543)", () => {
  const { store, clock } = setup();
  store.putSchedule({ sessionId: "session_one", prompt: "off", rule: { kind: "interval", everyMs: HOUR }, zone: "UTC", enabled: false });
  const good = store.putSchedule({ sessionId: "session_one", prompt: "on", rule: { kind: "interval", everyMs: HOUR }, zone: "UTC" });
  clock.now = START + 2 * HOUR;

  const acted = store.sweepSchedules();
  expect(acted).toEqual([good.id]);
  expect(turnCount(store)).toBe(1);
});

test("a row whose session is gone is disabled rather than retried for ever (#543)", () => {
  /**
   * The per-row catch, and what it does with the failure. Leaving the row
   * enabled would turn one deleted session into a permanent thirty-second tick;
   * deleting it would remove the only evidence the person had that they had
   * asked for something.
   */
  const { store, clock } = setup();
  store.createSession({ id: "session_two", projectId: "project_one" });
  const orphan = store.putSchedule({ sessionId: "session_two", prompt: "orphan", rule: { kind: "interval", everyMs: HOUR }, zone: "UTC" });
  const survivor = store.putSchedule({ sessionId: "session_one", prompt: "survivor", rule: { kind: "interval", everyMs: HOUR }, zone: "UTC" });
  store.deleteSession("session_two");

  clock.now = START + 2 * HOUR;
  store.sweepSchedules();

  // THE GOOD ROW STILL FIRED, which is what the per-row catch buys.
  expect(turnCount(store, "session_one")).toBe(1);
  const parked = store.readSchedule(orphan.id)!;
  expect(parked.enabled).toBe(false);
  expect(parked.nextRunAt).toBeGreaterThan(clock.now);
  expect(store.readSchedule(survivor.id)!.enabled).toBe(true);
});

test("the first nextRunAt is the ENGINE's, never the caller's (#543)", () => {
  // A client that could name it could aim a row at the past and make the grace
  // rule meaningless.
  const { store } = setup();
  const row = store.putSchedule({
    sessionId: "session_one",
    prompt: "daily",
    rule: { kind: "fixed", hour: 9, minute: 0, weekdays: [] },
    zone: "Asia/Tokyo",
  });
  expect(row.nextRunAt).toBeGreaterThan(START);
  expect(row.zone).toBe("Asia/Tokyo");
  // An unknown zone is stored as the fallback rather than kept and thrown on
  // later — the row is durable and has to keep working.
  const odd = store.putSchedule({ sessionId: "session_one", prompt: "x", rule: { kind: "interval", everyMs: HOUR }, zone: "Mars/Olympus" });
  expect(odd.zone).toBe("UTC");
});

test("a session with an enabled schedule reads as scheduled, dated by its soonest wake", () => {
  // It used to read `idle`, exactly like a session nothing will ever wake.
  const { store } = setup();
  expect(store.getSession("session_one").activity).toBe("idle");
  const hourly = store.putSchedule({ sessionId: "session_one", prompt: "status?", rule: { kind: "interval", everyMs: HOUR }, zone: "UTC" });
  store.putSchedule({ sessionId: "session_one", prompt: "digest", rule: { kind: "interval", everyMs: 3 * HOUR }, zone: "UTC" });
  const revision = store.sessionsRevision();
  expect(store.getSession("session_one")).toMatchObject({ activity: "scheduled", activityDetail: { kind: "schedule", at: hourly.nextRunAt } });

  // A disabled or deleted row wakes nothing, and the rail is told.
  store.putSchedule({ id: hourly.id, sessionId: "session_one", prompt: "status?", rule: { kind: "interval", everyMs: HOUR }, zone: "UTC", enabled: false });
  expect(store.sessionsRevision()).toBeGreaterThan(revision);
  expect(store.getSession("session_one").activityDetail).toMatchObject({ kind: "schedule", at: START + 3 * HOUR });
  for (const row of store.listSchedules("session_one")) store.deleteSchedule(row.id);
  expect(store.getSession("session_one").activity).toBe("idle");
});
