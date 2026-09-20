/**
 * A SNOOZE THAT ENDS SAYS SO — issues #490, #586.
 *
 * `snoozedUntil` was a stored timestamp and nothing else: "is this snoozed?" is
 * computed against `now`, and nothing scheduled anything at expiry. So there was
 * no moment at which a conversation woke and nothing could announce one — the
 * row silently reappeared whenever something happened to render after the
 * deadline. The owner: *"nos faltó añadir un punto de notificación para mostrar
 * que una conversación se despertó."*
 *
 * WHAT THESE TESTS ARE ACTUALLY ABOUT is not that a dot lights. It is that the
 * wake moment is decided ONCE, BY THE ENGINE, and that every reader is given the
 * same number afterwards. A per-row client timer would light the dot and have
 * two cockpits disagree about when the row woke; the tests below are written so
 * that such an implementation could not pass them:
 *
 *   - the recorded moment is the DEADLINE, never the tick that noticed it, and
 *     the two are asserted to differ rather than merely to exist;
 *   - a second store, opened later on a different clock, is handed the same
 *     number rather than its own;
 *   - a second sweep adds nothing, so "exactly one signal" is a property of the
 *     code and not of how often something happened to run.
 *
 * Counts throughout, never the presence of a string: a sweep that woke
 * everything and a sweep that woke the right row both emit `session.woke`.
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

const START = 1_700_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** One session on a clock a test can wind forward. */
function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-wake-"));
  homes.push(home);
  const clock = { now: START };
  const store = new EngineStore(home, () => clock.now, { executionStorage: "sqlite" });
  stores.push(store);
  store.registerProject({ id: "project_one", name: "test", root: "/tmp" });
  store.createSession({ id: "session_one", projectId: "project_one" });
  return { store, home, clock };
}

/** Re-open the same store directory as a DIFFERENT reader, on its own clock —
 *  which is the whole question this feature answers. */
function reopen(home: string, now: number) {
  const store = new EngineStore(home, () => now, { executionStorage: "sqlite" });
  stores.push(store);
  return store;
}

const wakes = (store: EngineStore, sessionId = "session_one") =>
  store.readEvents(sessionId).filter((event) => event.type === "session.woke");

test("a snooze that has run out wakes once, stamped at the DEADLINE and not at the tick", () => {
  const { store, clock } = setup();
  const until = START + HOUR;
  store.updateSession("session_one", { snoozedUntil: until });

  // Nothing is owed while it is still sleeping. Without this the test below
  // would pass just as well against a sweep that woke every row it was handed.
  expect(store.sweepSnoozeWakes()).toEqual([]);
  expect(wakes(store)).toHaveLength(0);

  // THE TICK IS DELIBERATELY LATE. A sweep runs on a cadence, so it always
  // notices after the fact; what it records must still be the moment the snooze
  // ended, or every engine would report when it happened to look.
  const noticedAt = until + 5 * MINUTE;
  clock.now = noticedAt;
  expect(store.sweepSnoozeWakes()).toEqual(["session_one"]);

  const woke = wakes(store);
  expect(woke).toHaveLength(1);
  expect(woke[0]).toMatchObject({ type: "session.woke", wokeAt: until });
  // A DIFFERENCE, NOT A FLOOR. The envelope's `at` is when the engine recorded
  // the row and `wokeAt` is when the conversation woke; asserting only that
  // both exist would pass against an implementation that stamped `now` twice.
  expect(woke[0]!.at).toBe(noticedAt);
  expect(woke[0]!.at - woke[0]!.wokeAt).toBe(5 * MINUTE);
  expect(store.getSession("session_one").wokeAt).toBe(until);
});

test("sweeping again adds nothing — exactly one signal, however often it runs", () => {
  const { store, clock } = setup();
  const until = START + HOUR;
  store.updateSession("session_one", { snoozedUntil: until });
  clock.now = until + MINUTE;
  expect(store.sweepSnoozeWakes()).toEqual(["session_one"]);

  // Four more passes, spread over a day. A row whose wake is recorded is not a
  // candidate any more, so the sweep has nothing to say about it.
  for (const hours of [1, 6, 12, 24]) {
    clock.now = until + hours * HOUR;
    expect(store.sweepSnoozeWakes()).toEqual([]);
  }
  expect(wakes(store)).toHaveLength(1);
});

test("a second reader, hours later and on its own clock, is handed the same moment", () => {
  const { store, home, clock } = setup();
  const until = START + HOUR;
  store.updateSession("session_one", { snoozedUntil: until });
  clock.now = until + MINUTE;
  store.sweepSnoozeWakes();
  store.closeExecutionStore();
  stores.splice(stores.indexOf(store), 1);

  // THE CLAUSE THE WHOLE DESIGN IS FOR. This reader's `now` is six hours past
  // the wake and nothing about its own clock enters the answer — a cockpit that
  // decided the moment locally would report when IT noticed, and two cockpits
  // would disagree. The number is the engine's, so there is only one of it.
  const later = until + 6 * HOUR;
  const second = reopen(home, later);
  expect(second.getSession("session_one").wokeAt).toBe(until);
  expect(second.getSession("session_one").wokeAt).not.toBe(later);
  // And it is on the wire the rail already reads, not only in the document.
  const row = second.liveSessionRows({ all: true }).sessions.find((session) => session.id === "session_one");
  expect(row?.wokeAt).toBe(until);
});

test("waking does not touch updatedAt, so a woken row does not jump the list", () => {
  const { store, clock } = setup();
  const until = START + HOUR;
  store.updateSession("session_one", { snoozedUntil: until });
  const before = store.getSession("session_one").updatedAt;

  clock.now = until + MINUTE;
  expect(store.sweepSnoozeWakes()).toEqual(["session_one"]);

  // `idleSince` already counts the wake as the start of the inactivity window,
  // and the list's sort is deliberately static (`settling.ts`) — so stamping
  // here would both read as fresh work and reorder a list somebody is reading.
  expect(store.getSession("session_one").updatedAt).toBe(before);
});

test("a new snooze clears the recorded wake, so the NEXT one can still be announced", () => {
  const { store, clock } = setup();
  const first = START + HOUR;
  store.updateSession("session_one", { snoozedUntil: first });
  clock.now = first + MINUTE;
  store.sweepSnoozeWakes();
  expect(wakes(store)).toHaveLength(1);

  // Snoozed again. A stale stamp left on the record would take this session out
  // of the candidate query for good, and the second wake would be the silent
  // one — the original defect, reintroduced one snooze later.
  const second = clock.now + 3 * HOUR;
  store.updateSession("session_one", { snoozedUntil: second });
  expect(store.getSession("session_one").wokeAt).toBeUndefined();
  expect(store.sweepSnoozeWakes()).toEqual([]);

  clock.now = second + MINUTE;
  expect(store.sweepSnoozeWakes()).toEqual(["session_one"]);
  const woke = wakes(store);
  expect(woke).toHaveLength(2);
  expect(woke.map((event) => event.wokeAt)).toEqual([first, second]);
});

test("the wake moves the revision the rail's conditional read is keyed on", () => {
  const { store, clock } = setup();
  const until = START + HOUR;
  store.updateSession("session_one", { snoozedUntil: until });
  const before = store.liveSessionRows().revision;

  clock.now = until + MINUTE;
  expect(store.sweepSnoozeWakes()).toEqual(["session_one"]);

  // WITHOUT THIS THE SWEEP WOULD BE INVISIBLE. A rail polls conditionally and a
  // quiet tick is a 304 with no body (#459); a wake written without moving the
  // cursor would sit on disk until some unrelated write happened to carry it,
  // which is the silent reappearance this whole change is about. This is the
  // sense in which the edge is delivered on the read the rail already makes —
  // #586's body is explicit that browser clients keep polling.
  const after = store.liveSessionRows();
  expect(after.revision).toBeGreaterThan(before);
  // On the DEFAULT answer, not only under `?all=1`: a live snooze is not
  // shelved (`isSettled` returns false for it deliberately), so the row was on
  // the list all along and the wake is a write to a row a rail is drawing.
  expect(after.sessions.find((session) => session.id === "session_one")?.wokeAt).toBe(until);
});

test("work landing on a sleeping conversation wakes it there and then, not at the deadline", () => {
  const { store, clock } = setup();
  store.updateSession("session_one", { snoozedUntil: START + 8 * HOUR });

  // The sweep cannot reach this case: submitting work deletes the snooze, so a
  // pass arriving afterwards sees a session that never slept. Nothing expired
  // here either — the work is what woke it, hours early.
  clock.now = START + 10 * MINUTE;
  store.submitTurn("session_one", { runId: "run_one", input: "are you there" });

  const woke = wakes(store);
  expect(woke).toHaveLength(1);
  expect(woke[0]!.wokeAt).toBe(START + 10 * MINUTE);
  expect(store.getSession("session_one").snoozedUntil).toBeUndefined();
  // And the sweep still has nothing to add afterwards.
  clock.now = START + 9 * HOUR;
  expect(store.sweepSnoozeWakes()).toEqual([]);
  expect(wakes(store)).toHaveLength(1);
});
