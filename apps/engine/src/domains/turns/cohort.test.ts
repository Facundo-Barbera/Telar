/**
 * A COHORT — one wake when several sessions are all done.
 *
 * A fan-out subscribed member by member woke its coordinator once per child.
 * Under test: the cohort holds each member's result and ending and delivers
 * ONE notification, a line per member, when the last is done; a blocker and a
 * parked request still pass through at once; a blocked member stays pending;
 * a member put away ends its wait; and the cohort expires on a fake clock.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cohortNotification, mergeNotifications, wakeNotification } from "./notification";
import { EngineStore } from "../../state";

const homes: string[] = [];
const stores: EngineStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.kernel.executionStore.close();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-cohort-"));
  homes.push(home);
  let now = 1_000_000;
  const clock = { advance: (ms: number) => (now += ms) };
  const store = new EngineStore(home, () => now);
  stores.push(store);
  store.projectRegistry.register({ id: "project_one", name: "test", root: "/tmp" });
  for (const id of ["session_host", "session_a", "session_b", "session_c"]) store.lifecycle.createSession({ id, projectId: "project_one", title: id.replace("session_", "worker ") });
  /** Telar restarting: the same home, a new engine, and its boot sweep. */
  const restart = () => {
    const next = new EngineStore(home, () => now);
    stores.push(next);
    next.recovery.recover();
    return next;
  };
  return { store, clock, restart, home, now: () => now };
}

/** Start a run on a member, as if the host's task had just been claimed. */
function start(store: EngineStore, sessionId: string, runId: string) {
  store.intake.submitTurn(sessionId, { runId, input: "work" });
  const token = store.claims.claimTurn(sessionId, "worker_child")!.claim!.token;
  store.turnLifecycle.markRunning(sessionId, runId, token);
  const proof = { sessionId, runId, claimToken: token };
  return {
    send: (intent: "result" | "blocker" | "report", text: string) =>
      store.intake.submitAgentTurn("session_host", { runId: `run_msg_${runId}_${intent}`, input: text, intent }, proof),
    complete: (text = "done") => store.turnLifecycle.completeTurn(sessionId, runId, token, { text }),
    fail: () => store.turnLifecycle.failTurn(sessionId, runId, token, { code: "driver_failed", message: "the CLI died" }),
    token,
  };
}

/** Turns on the host that a model would be handed. */
const woken = (store: EngineStore) => store.queries.turns("session_host").filter((turn) => turn.origin === "session" && turn.agentDelivery !== "passive");

test("the cohort delivers ONCE, after the last member, with a line per member", () => {
  const { store } = setup();
  const a = start(store, "session_a", "run_a");
  const b = start(store, "session_b", "run_b");
  const c = start(store, "session_c", "run_c");
  const cohort = store.subscriptions.subscribeCohort("session_host", { sessionIds: ["session_a", "session_b", "session_c"] });
  expect(cohort.members.every((member) => !member.outcome)).toBe(true);

  a.send("result", "Merged #12; CI green.\nDetails follow.");
  a.complete();
  b.fail();
  // Two of three done, and nothing has woken the host: the result is held.
  expect(woken(store)).toHaveLength(0);
  expect(store.queries.turns("session_host").find((turn) => turn.runId === "run_msg_run_a_result")!.agentDelivery).toBe("passive");
  expect(store.wakes.pendingNotifications("session_host")).toHaveLength(0);

  c.complete("Refactored the parser.");
  const delivered = woken(store);
  expect(delivered).toHaveLength(1);
  const detail = delivered[0]!.notification!;
  expect(detail.cohortId).toBe(cohort.id);
  // Where a transcript's fold of the host's reactions begins.
  expect(detail.cohortOpenedAt).toBe(cohort.createdAt);
  expect(detail.body.startsWith("[cohort done · all 3 sessions finished]")).toBe(true);
  expect(detail.body).toContain('1. session_a "worker a" — result: Merged #12; CI green. · sessions_read(sessionId: "session_host", runId: "run_msg_run_a_result")');
  expect(detail.body).toContain('2. session_b "worker b" — FAILED: driver_failed: the CLI died · sessions_read(sessionId: "session_b", runId: "run_b")');
  expect(detail.body).toContain('3. session_c "worker c" — completed: Refactored the parser.');
  expect(detail.body).not.toContain("Details follow.");
  expect(detail.entries?.map((entry) => entry.sessionId)).toEqual(["session_a", "session_b", "session_c"]);
  // The last to finish leads.
  expect(delivered[0]!.wakeReason).toMatchObject({ kind: "turn_completed", sessionId: "session_c", runId: "run_c" });
  // Delivered means gone.
  expect(store.subscriptions.cohortsFor("session_host")).toHaveLength(0);
});

test("a blocker passes through at once, and its member stays pending until answered", () => {
  const { store } = setup();
  const a = start(store, "session_a", "run_a");
  const b = start(store, "session_b", "run_b");
  store.subscriptions.subscribeCohort("session_host", { sessionIds: ["session_a", "session_b"] });

  a.send("blocker", "Which database?");
  // IMMEDIATELY: a wake of its own, not held for the cohort.
  expect(woken(store).map((turn) => turn.agentIntent)).toEqual(["blocker"]);
  // The worker ends its turn to wait for the answer — that is not done.
  a.complete("waiting on the host");
  b.complete();
  expect(woken(store)).toHaveLength(1);
  expect(store.subscriptions.cohortsFor("session_host")[0]!.members.find((member) => member.sessionId === "session_a")).toMatchObject({ blocked: true });

  // The host answers. Now on the host's errand, the member's turn ending is
  // not its end — its result is.
  const host = store.claims.claimTurn("session_host", "worker_host")!;
  store.turnLifecycle.markRunning("session_host", host.runId, host.claim!.token);
  store.intake.submitAgentTurn("session_a", { runId: "run_answer", input: "postgres", intent: "task" }, { sessionId: "session_host", runId: host.runId, claimToken: host.claim!.token });
  store.turnLifecycle.completeTurn("session_host", host.runId, host.claim!.token, { text: "answered" });
  const next = store.claims.claimTurn("session_a", "worker_child")!;
  store.turnLifecycle.markRunning("session_a", next.runId, next.claim!.token);
  store.intake.submitAgentTurn("session_host", { runId: "run_msg_answer_result", input: "Used postgres.", intent: "result" }, { sessionId: "session_a", runId: next.runId, claimToken: next.claim!.token });
  store.turnLifecycle.completeTurn("session_a", next.runId, next.claim!.token, { text: "Result sent." });

  const cohortTurns = woken(store).filter((turn) => turn.notification?.cohortId);
  expect(cohortTurns).toHaveLength(1);
  expect(cohortTurns[0]!.notification!.body).toContain("session_a \"worker a\" — result: Used postgres.");
});

test("a parked request passes through at once", () => {
  const { store } = setup();
  store.subscriptions.subscribeCohort("session_host", { sessionIds: ["session_a", "session_b"] });
  store.intake.submitTurn("session_a", { runId: "run_a", input: "work" });
  const token = store.claims.claimTurn("session_a", "worker_child")!.claim!.token;
  store.turnLifecycle.markRunning("session_a", "run_a", token);
  store.lifecycle.updateSession("session_a", { runtimeMode: "approval-required" });
  store.requestGate.open("session_a", "run_a", token, {
    requestId: "req_a",
    kind: "user_input",
    detail: { kind: "user_input", prompt: "Which?", fields: [{ key: "k", label: "K", kind: "choice", choices: ["x"] }] },
  });
  const wakes = woken(store);
  expect(wakes).toHaveLength(1);
  expect(wakes[0]!.wakeReason).toMatchObject({ kind: "request_opened", sessionId: "session_a", requestId: "req_a" });
  expect(store.subscriptions.cohortsFor("session_host")).toHaveLength(1);
});

test("expiry delivers what arrived and names who is still pending", () => {
  const { store, clock } = setup();
  const a = start(store, "session_a", "run_a");
  start(store, "session_b", "run_b");
  store.subscriptions.subscribeCohort("session_host", { sessionIds: ["session_a", "session_b"], timeoutMinutes: 30 });
  a.send("result", "Done with A.");

  clock.advance(29 * 60_000);
  expect(store.subscriptions.sweepCohorts()).toEqual([]);
  expect(woken(store)).toHaveLength(0);

  clock.advance(60_000);
  expect(store.subscriptions.sweepCohorts()).toHaveLength(1);
  const [turn] = woken(store);
  expect(turn!.notification!.body.startsWith("[cohort expired · 1 of 2 sessions finished in 30 min]")).toBe(true);
  expect(turn!.notification!.body).toContain('session_b "worker b" — STILL PENDING (no result sent)');
  expect(turn!.notification!.body).toContain("subscribe again with the pending ones");
  expect(store.subscriptions.cohortsFor("session_host")).toHaveLength(0);
});

test("a member settled or deleted before it reported ends its wait", () => {
  const { store } = setup();
  const a = start(store, "session_a", "run_a");
  start(store, "session_b", "run_b");
  store.lifecycle.createSession({ id: "session_d", projectId: "project_one", title: "worker d" });
  store.subscriptions.subscribeCohort("session_host", { sessionIds: ["session_a", "session_b", "session_d"] });
  a.complete("A finished.");
  store.lifecycle.updateSession("session_b", { settledOverride: "settled" });
  expect(woken(store)).toHaveLength(0);
  store.lifecycle.deleteSession("session_d");

  const [turn] = woken(store);
  expect(turn!.notification!.body).toContain('session_b "worker b" — settled before it reported');
  expect(turn!.notification!.body).toContain('session_d "worker d" — deleted before it reported');
});

test("a cohort closing while the host is busy waits for it to settle, as its own turn", () => {
  const { store } = setup();
  const a = start(store, "session_a", "run_a");
  store.subscriptions.subscribeCohort("session_host", { sessionIds: ["session_a"] });
  store.intake.submitTurn("session_host", { runId: "run_host", input: "a long think" });
  const host = store.claims.claimTurn("session_host", "worker_host")!.claim!.token;
  store.turnLifecycle.markRunning("session_host", "run_host", host);

  a.complete("A finished.");
  expect(store.queries.turns("session_host").some((turn) => turn.notification?.cohortId)).toBe(false);
  expect(store.subscriptions.cohortsFor("session_host")[0]!.ready).toBe("all");

  store.turnLifecycle.completeTurn("session_host", "run_host", host, { text: "thought" });
  expect(woken(store).filter((turn) => turn.notification?.cohortId)).toHaveLength(1);
  expect(store.subscriptions.cohortsFor("session_host")).toHaveLength(0);
});

/** The host hands `sessionId` an errand; returns the member's claimed run on it. */
function errand(store: EngineStore, sessionId: string) {
  const host = store.intake.submitTurn("session_host", { runId: `run_host_${sessionId}`, input: "fan out" });
  const claim = store.claims.claimTurn("session_host", "worker_host")!.claim!.token;
  store.turnLifecycle.markRunning("session_host", host.turn.runId, claim);
  store.intake.submitAgentTurn(sessionId, { runId: `run_task_${sessionId}`, input: "do it", intent: "task" }, { sessionId: "session_host", runId: host.turn.runId, claimToken: claim });
  store.turnLifecycle.completeTurn("session_host", host.turn.runId, claim, { text: "dispatched" });
  const child = store.claims.claimTurn(sessionId, "worker_child")!;
  store.turnLifecycle.markRunning(sessionId, child.runId, child.claim!.token);
  const proof = { sessionId, runId: child.runId, claimToken: child.claim!.token };
  return {
    result: (text: string) => store.intake.submitAgentTurn("session_host", { runId: `run_result_${sessionId}`, input: text, intent: "result" }, proof),
    complete: (text: string) => store.turnLifecycle.completeTurn(sessionId, child.runId, child.claim!.token, { text }),
    fail: () => store.turnLifecycle.failTurn(sessionId, child.runId, child.claim!.token, { code: "driver_failed", message: "the CLI died" }),
  };
}

test("a member that only ENDED A TURN on the host's errand is not done at subscribe", () => {
  const { store } = setup();
  // Mid-errand: the worker ended its turn waiting on CI, and sent no result.
  errand(store, "session_a").complete("Waiting on CI.");
  const cohort = store.subscriptions.subscribeCohort("session_host", { sessionIds: ["session_a", "session_b"] });
  expect(cohort.members.find((member) => member.sessionId === "session_a")!.outcome).toBeUndefined();
  expect(woken(store).filter((turn) => turn.notification?.cohortId)).toHaveLength(0);
});

test("a member whose result is already in is done at once", () => {
  const { store } = setup();
  const a = errand(store, "session_a");
  a.result("A was quick.");
  a.complete("Result sent.");
  const cohort = store.subscriptions.subscribeCohort("session_host", { sessionIds: ["session_a", "session_b"] });
  expect(cohort.members.find((member) => member.sessionId === "session_a")).toMatchObject({ outcome: "result", firstLine: "A was quick." });
  // session_b was never given anything by the host: pending.
  expect(cohort.members.find((member) => member.sessionId === "session_b")!.outcome).toBeUndefined();
});

test("on an errand, done is a result, a failure or a stop — never a turn that merely completed", () => {
  const { store } = setup();
  const a = errand(store, "session_a");
  const b = errand(store, "session_b");
  store.subscriptions.subscribeCohort("session_host", { sessionIds: ["session_a", "session_b"] });

  a.complete("Pushed; waiting on CI.");
  expect(store.subscriptions.cohortsFor("session_host")[0]!.members.every((member) => !member.outcome)).toBe(true);
  b.fail();
  expect(store.subscriptions.cohortsFor("session_host")[0]!.members.find((member) => member.sessionId === "session_b")!.outcome).toBe("failed");

  // A's CI finishes in a later turn, and its result is what ends the wait.
  store.intake.submitTurn("session_a", { runId: "run_a_ci", input: "CI is green" });
  const later = store.claims.claimTurn("session_a", "worker_child")!;
  store.turnLifecycle.markRunning("session_a", later.runId, later.claim!.token);
  store.intake.submitAgentTurn("session_host", { runId: "run_a_final", input: "PR green.", intent: "result" }, { sessionId: "session_a", runId: later.runId, claimToken: later.claim!.token });
  const [turn] = woken(store).filter((each) => each.notification?.cohortId);
  expect(turn!.notification!.body).toContain('session_a "worker a" — result: PR green.');
  expect(turn!.notification!.body).toContain('session_b "worker b" — FAILED');
});

test("a failed turn ends even a blocked member's wait", () => {
  const { store } = setup();
  const a = start(store, "session_a", "run_a");
  store.subscriptions.subscribeCohort("session_host", { sessionIds: ["session_a"] });
  a.send("blocker", "Which database?");
  a.fail();
  const [turn] = woken(store).filter((each) => each.notification?.cohortId);
  expect(turn!.notification!.body).toContain('session_a "worker a" — FAILED');
});

test("unsubscribing takes a cohort id; a session cannot be in its own cohort", () => {
  const { store } = setup();
  const cohort = store.subscriptions.subscribeCohort("session_host", { sessionIds: ["session_a"] });
  expect(store.subscriptions.unsubscribe(cohort.id, "session_a")).toBe(false);
  expect(store.subscriptions.unsubscribe(cohort.id, "session_host")).toBe(true);
  expect(store.subscriptions.cohortsFor("session_host")).toHaveLength(0);
  expect(() => store.subscriptions.subscribeCohort("session_host", { sessionIds: ["session_host"] })).toThrow("its own cohort");
  expect(() => store.subscriptions.subscribeCohort("session_host", { sessionIds: ["session_a"], timeoutMinutes: 0 })).toThrow("timeoutMinutes");
});

test("the host reads as waiting while a cohort member is working", () => {
  const { store } = setup();
  start(store, "session_a", "run_a");
  store.subscriptions.subscribeCohort("session_host", { sessionIds: ["session_a"] });
  expect(store.records.get("session_host").activity).toBe("waiting");
});

test("a cohort's close merged under a later wake still names its cohort and when it opened", () => {
  const close = cohortNotification({
    cohortId: "coh_one",
    openedAt: 500,
    members: [{ sessionId: "session_a", outcome: "completed", at: 900 }],
    reason: "all",
    minutes: 240,
    fallbackFetch: { sessionId: "session_a", runId: "coh_one" },
  });
  const later = wakeNotification({ targetSessionId: "session_z", runId: "run_z", wakeKind: "turn_completed", body: "session_z finished" });
  const merged = mergeNotifications([close, later]);
  expect(merged.entries).toHaveLength(2);
  expect(merged).toMatchObject({ cohortId: "coh_one", cohortOpenedAt: 500 });
  // Nothing to carry: a plain merge gains no cohort.
  expect(mergeNotifications([later, wakeNotification({ targetSessionId: "session_y", runId: "run_y", wakeKind: "turn_completed", body: "y" })]).cohortId).toBeUndefined();
});

test("a cohort of ONE quotes what its member said, like the single wake it replaces", () => {
  const { store } = setup();
  const a = start(store, "session_a", "run_a");
  store.subscriptions.subscribeCohort("session_host", { sessionIds: ["session_a"] });
  const long = `PR #7 is green.\n${"detail ".repeat(400)}`;
  a.send("result", long);
  a.complete();
  const [turn] = woken(store);
  const body = turn!.notification!.body;
  expect(body).toContain("PR #7 is green.");
  expect(body).toContain("<<<");
  expect(body).toMatch(/more chars not shown/);
  // Several members stay one line each.
  const two = setup();
  const x = start(two.store, "session_a", "run_x");
  const y = start(two.store, "session_b", "run_y");
  two.store.subscriptions.subscribeCohort("session_host", { sessionIds: ["session_a", "session_b"] });
  x.send("result", long);
  y.send("result", "Done.");
  x.complete();
  y.complete();
  expect(woken(two.store)[0]!.notification!.body).not.toContain("<<<");
});

/** The host tasks `sessionId` (run ids suffixed by `tag`); returns the member's claimed run. */
function task(store: EngineStore, sessionId: string, tag: string) {
  const host = store.intake.submitTurn("session_host", { runId: `run_host_${tag}`, input: "fan out" });
  const claim = store.claims.claimTurn("session_host", "worker_host")!.claim!.token;
  store.turnLifecycle.markRunning("session_host", host.turn.runId, claim);
  store.intake.submitAgentTurn(sessionId, { runId: `run_task_${tag}`, input: "do it", intent: "task" }, { sessionId: "session_host", runId: host.turn.runId, claimToken: claim });
  store.turnLifecycle.completeTurn("session_host", host.turn.runId, claim, { text: "dispatched" });
  const child = store.claims.claimTurn(sessionId, "worker_child")!;
  store.turnLifecycle.markRunning(sessionId, child.runId, child.claim!.token);
  return { sessionId, runId: child.runId, claimToken: child.claim!.token };
}

test("re-subscribing after a restart does not deliver the member's one result twice", () => {
  const { store, restart } = setup();
  task(store, "session_a", "one");
  const first = store.subscriptions.subscribeCohort("session_host", { sessionIds: ["session_a"] });
  // Telar restarts: the member's turn is stopped by the boot, not by anyone.
  const after = restart();
  expect(after.queries.turns("session_a").at(-1)).toMatchObject({ state: "stopped", stopReason: "engine_restart" });
  // The coordinator re-tasks it and subscribes again.
  const proof = task(after, "session_a", "two");
  const second = after.subscriptions.subscribeCohort("session_host", { sessionIds: ["session_a"] });
  expect(second).toMatchObject({ id: first.id, expiresAt: first.expiresAt, alreadySubscribed: true });
  expect(after.subscriptions.cohortsFor("session_host")).toHaveLength(1);

  after.intake.submitAgentTurn("session_host", { runId: "run_the_result", input: "Done.", intent: "result" }, proof);
  after.turnLifecycle.completeTurn("session_a", proof.runId, proof.claimToken, { text: "Result sent." });
  const notices = woken(after).filter((turn) => turn.notification?.cohortId);
  expect(notices).toHaveLength(1);
  expect(notices[0]!.notification!.cohortId).toBe(first.id);
});

test("an overlapping cohort takes its members over; the older one keeps the rest", () => {
  const { store } = setup();
  const older = store.subscriptions.subscribeCohort("session_host", { sessionIds: ["session_a", "session_b"] });
  const newer = store.subscriptions.subscribeCohort("session_host", { sessionIds: ["session_b", "session_c"] });
  expect(newer.alreadySubscribed).toBeUndefined();
  expect(newer.movedFrom).toEqual([older.id]);
  const open = store.subscriptions.cohortsFor("session_host");
  expect(open.find((each) => each.id === older.id)!.members.map((member) => member.sessionId)).toEqual(["session_a"]);
  expect(open.find((each) => each.id === newer.id)!.members.map((member) => member.sessionId)).toEqual(["session_b", "session_c"]);

  // A superset empties the older cohort, and it goes.
  const all = store.subscriptions.subscribeCohort("session_host", { sessionIds: ["session_a", "session_b", "session_c"] });
  expect(new Set(all.movedFrom)).toEqual(new Set([older.id, newer.id]));
  expect(store.subscriptions.cohortsFor("session_host").map((each) => each.id)).toEqual([all.id]);
});

test("the same set in another order is the same cohort", () => {
  const { store } = setup();
  const first = store.subscriptions.subscribeCohort("session_host", { sessionIds: ["session_a", "session_b"] });
  expect(store.subscriptions.subscribeCohort("session_host", { sessionIds: ["session_b", "session_a", "session_b"] })).toMatchObject({ id: first.id, alreadySubscribed: true });
});

test("a restart is not a stop: the cohort survives it, pending, with its original expiry", () => {
  const { store, clock, restart } = setup();
  task(store, "session_a", "one");
  const cohort = store.subscriptions.subscribeCohort("session_host", { sessionIds: ["session_a"], timeoutMinutes: 60 });
  clock.advance(10 * 60_000);
  const after = restart();
  expect(after.queries.turns("session_a").at(-1)).toMatchObject({ state: "stopped", stopReason: "engine_restart" });
  expect(after.subscriptions.cohortsFor("session_host")).toEqual([cohort]);
  clock.advance(49 * 60_000);
  expect(after.subscriptions.sweepCohorts()).toEqual([]);

  const proof = task(after, "session_a", "two");
  after.intake.submitAgentTurn("session_host", { runId: "run_the_result", input: "Done.", intent: "result" }, proof);
  const notices = woken(after).filter((turn) => turn.notification?.cohortId);
  expect(notices).toHaveLength(1);
  expect(notices[0]!.notification!.body).toContain('session_a "worker a" — result: Done.');
});

test("a member cut off by a restart is pending when subscribed to, not stopped", () => {
  const { store, restart } = setup();
  task(store, "session_a", "one");
  const after = restart();
  const cohort = after.subscriptions.subscribeCohort("session_host", { sessionIds: ["session_a"] });
  expect(cohort.members[0]!.outcome).toBeUndefined();
  expect(woken(after).filter((turn) => turn.notification?.cohortId)).toHaveLength(0);
});

test("a turn failed as interrupted by a worker shutting down does not end the member's wait", () => {
  const { store } = setup();
  const proof = task(store, "session_a", "one");
  store.subscriptions.subscribeCohort("session_host", { sessionIds: ["session_a"] });
  store.turnLifecycle.failTurn("session_a", proof.runId, proof.claimToken, { code: "interrupted", message: "Telar quit while this turn was running." });
  expect(store.subscriptions.cohortsFor("session_host")[0]!.members[0]!.outcome).toBeUndefined();
  expect(woken(store).filter((turn) => turn.notification?.cohortId)).toHaveLength(0);
});

/**
 * Two open cohorts on one member, as `subscribeCohort` could store them before
 * it became idempotent: written straight to disk, then read by a new engine.
 */
function storeOverlapping(home: string, cohorts: Array<{ id: string; members: string[] }>, at: number) {
  const file = path.join(home, "cohorts.json");
  const stored = JSON.parse(fs.readFileSync(file, "utf8")) as { cohorts: unknown[] };
  for (const cohort of cohorts) {
    stored.cohorts.push({
      id: cohort.id,
      subscriberSessionId: "session_host",
      members: cohort.members.map((sessionId) => ({ sessionId, title: sessionId.replace("session_", "worker ") })),
      createdAt: at,
      expiresAt: at + 240 * 60_000,
    });
  }
  fs.writeFileSync(file, JSON.stringify(stored));
}

test("two cohorts on one member after a restart deliver its one result once", () => {
  const { store, restart, home, now } = setup();
  task(store, "session_a", "one");
  store.subscriptions.subscribeCohort("session_host", { sessionIds: ["session_a"] });
  storeOverlapping(home, [{ id: "coh_second", members: ["session_a"] }], now());
  const after = restart();
  expect(after.subscriptions.cohortsFor("session_host")).toHaveLength(2);
  const proof = task(after, "session_a", "two");

  after.intake.submitAgentTurn("session_host", { runId: "run_the_result", input: "Done.", intent: "result" }, proof);
  after.turnLifecycle.completeTurn("session_a", proof.runId, proof.claimToken, { text: "Result sent." });
  expect(woken(after).filter((turn) => turn.notification?.cohortId)).toHaveLength(1);
  expect(after.subscriptions.cohortsFor("session_host")).toHaveLength(0);
});

test("a later cohort's notice leaves out a member an earlier one already reported", () => {
  const { store, restart, home, now } = setup();
  store.subscriptions.subscribeCohort("session_host", { sessionIds: ["session_c"] });
  storeOverlapping(home, [{ id: "coh_first", members: ["session_a"] }, { id: "coh_both", members: ["session_a", "session_b"] }], now());
  const after = restart();
  const a = task(after, "session_a", "a");
  const b = task(after, "session_b", "b");

  after.intake.submitAgentTurn("session_host", { runId: "run_result_a", input: "A done.", intent: "result" }, a);
  expect(woken(after).filter((turn) => turn.notification?.cohortId)).toHaveLength(1);
  after.intake.submitAgentTurn("session_host", { runId: "run_result_b", input: "B done.", intent: "result" }, b);
  const notices = woken(after).filter((turn) => turn.notification?.cohortId);
  expect(notices).toHaveLength(2);
  expect(notices[1]!.notification!.body).toContain("B done.");
  expect(notices[1]!.notification!.body).not.toContain("A done.");
});
