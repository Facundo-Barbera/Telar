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
import { EngineStore } from "../src/state";

const homes: string[] = [];
const stores: EngineStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.closeExecutionStore();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-cohort-"));
  homes.push(home);
  let now = 1_000_000;
  const clock = { advance: (ms: number) => (now += ms) };
  const store = new EngineStore(home, () => now, { executionStorage: "sqlite" });
  stores.push(store);
  store.registerProject({ id: "project_one", name: "test", root: "/tmp" });
  for (const id of ["session_host", "session_a", "session_b", "session_c"]) store.createSession({ id, projectId: "project_one", title: id.replace("session_", "worker ") });
  return { store, clock };
}

/** Start a run on a member, as if the host's task had just been claimed. */
function start(store: EngineStore, sessionId: string, runId: string) {
  store.submitTurn(sessionId, { runId, input: "work" });
  const token = store.claimTurn(sessionId, "worker_child")!.claim!.token;
  store.markRunning(sessionId, runId, token);
  const proof = { sessionId, runId, claimToken: token };
  return {
    send: (intent: "result" | "blocker" | "report", text: string) =>
      store.submitAgentTurn("session_host", { runId: `run_msg_${runId}_${intent}`, input: text, intent }, proof),
    complete: (text = "done") => store.completeTurn(sessionId, runId, token, { text }),
    fail: () => store.failTurn(sessionId, runId, token, { code: "driver_failed", message: "the CLI died" }),
    token,
  };
}

/** Turns on the host that a model would be handed. */
const woken = (store: EngineStore) => store.turns("session_host").filter((turn) => turn.origin === "session" && turn.agentDelivery !== "passive");

test("the cohort delivers ONCE, after the last member, with a line per member", () => {
  const { store } = setup();
  const a = start(store, "session_a", "run_a");
  const b = start(store, "session_b", "run_b");
  const c = start(store, "session_c", "run_c");
  const cohort = store.subscribeCohort("session_host", { sessionIds: ["session_a", "session_b", "session_c"] });
  expect(cohort.members.every((member) => !member.outcome)).toBe(true);

  a.send("result", "Merged #12; CI green.\nDetails follow.");
  a.complete();
  b.fail();
  // Two of three done, and nothing has woken the host: the result is held.
  expect(woken(store)).toHaveLength(0);
  expect(store.turns("session_host").find((turn) => turn.runId === "run_msg_run_a_result")!.agentDelivery).toBe("passive");
  expect(store.pendingNotifications("session_host")).toHaveLength(0);

  c.complete("Refactored the parser.");
  const delivered = woken(store);
  expect(delivered).toHaveLength(1);
  const detail = delivered[0]!.notification!;
  expect(detail.cohortId).toBe(cohort.id);
  expect(detail.body.startsWith("[cohort done · all 3 sessions finished]")).toBe(true);
  expect(detail.body).toContain('1. session_a "worker a" — result: Merged #12; CI green. · sessions_read(sessionId: "session_host", runId: "run_msg_run_a_result")');
  expect(detail.body).toContain('2. session_b "worker b" — FAILED: driver_failed: the CLI died · sessions_read(sessionId: "session_b", runId: "run_b")');
  expect(detail.body).toContain('3. session_c "worker c" — completed: Refactored the parser.');
  expect(detail.body).not.toContain("Details follow.");
  expect(detail.entries?.map((entry) => entry.sessionId)).toEqual(["session_a", "session_b", "session_c"]);
  // The last to finish leads.
  expect(delivered[0]!.wakeReason).toMatchObject({ kind: "turn_completed", sessionId: "session_c", runId: "run_c" });
  // Delivered means gone.
  expect(store.cohortsFor("session_host")).toHaveLength(0);
});

test("a blocker passes through at once, and its member stays pending until answered", () => {
  const { store } = setup();
  const a = start(store, "session_a", "run_a");
  const b = start(store, "session_b", "run_b");
  store.subscribeCohort("session_host", { sessionIds: ["session_a", "session_b"] });

  a.send("blocker", "Which database?");
  // IMMEDIATELY: a wake of its own, not held for the cohort.
  expect(woken(store).map((turn) => turn.agentIntent)).toEqual(["blocker"]);
  // The worker ends its turn to wait for the answer — that is not done.
  a.complete("waiting on the host");
  b.complete();
  expect(woken(store)).toHaveLength(1);
  expect(store.cohortsFor("session_host")[0]!.members.find((member) => member.sessionId === "session_a")).toMatchObject({ blocked: true });

  // The host answers; the member's next turn ending is its real end.
  const host = store.claimTurn("session_host", "worker_host")!;
  store.markRunning("session_host", host.runId, host.claim!.token);
  store.submitAgentTurn("session_a", { runId: "run_answer", input: "postgres", intent: "task" }, { sessionId: "session_host", runId: host.runId, claimToken: host.claim!.token });
  store.completeTurn("session_host", host.runId, host.claim!.token, { text: "answered" });
  const next = store.claimTurn("session_a", "worker_child")!;
  store.markRunning("session_a", next.runId, next.claim!.token);
  store.completeTurn("session_a", next.runId, next.claim!.token, { text: "Used postgres." });

  const cohortTurns = woken(store).filter((turn) => turn.notification?.cohortId);
  expect(cohortTurns).toHaveLength(1);
  expect(cohortTurns[0]!.notification!.body).toContain("session_a \"worker a\" — completed: Used postgres.");
});

test("a parked request passes through at once", () => {
  const { store } = setup();
  store.subscribeCohort("session_host", { sessionIds: ["session_a", "session_b"] });
  store.submitTurn("session_a", { runId: "run_a", input: "work" });
  const token = store.claimTurn("session_a", "worker_child")!.claim!.token;
  store.markRunning("session_a", "run_a", token);
  store.updateSession("session_a", { runtimeMode: "approval-required" });
  store.openRequest("session_a", "run_a", token, {
    requestId: "req_a",
    kind: "user_input",
    detail: { kind: "user_input", prompt: "Which?", fields: [{ key: "k", label: "K", kind: "choice", choices: ["x"] }] },
  });
  const wakes = woken(store);
  expect(wakes).toHaveLength(1);
  expect(wakes[0]!.wakeReason).toMatchObject({ kind: "request_opened", sessionId: "session_a", requestId: "req_a" });
  expect(store.cohortsFor("session_host")).toHaveLength(1);
});

test("expiry delivers what arrived and names who is still pending", () => {
  const { store, clock } = setup();
  const a = start(store, "session_a", "run_a");
  start(store, "session_b", "run_b");
  store.subscribeCohort("session_host", { sessionIds: ["session_a", "session_b"], timeoutMinutes: 30 });
  a.send("result", "Done with A.");

  clock.advance(29 * 60_000);
  expect(store.sweepCohorts()).toEqual([]);
  expect(woken(store)).toHaveLength(0);

  clock.advance(60_000);
  expect(store.sweepCohorts()).toHaveLength(1);
  const [turn] = woken(store);
  expect(turn!.notification!.body.startsWith("[cohort expired · 1 of 2 sessions finished in 30 min]")).toBe(true);
  expect(turn!.notification!.body).toContain('session_b "worker b" — STILL PENDING');
  expect(turn!.notification!.body).toContain("subscribe again with the pending ones");
  expect(store.cohortsFor("session_host")).toHaveLength(0);
});

test("a member settled or deleted before it reported ends its wait", () => {
  const { store } = setup();
  const a = start(store, "session_a", "run_a");
  start(store, "session_b", "run_b");
  store.createSession({ id: "session_d", projectId: "project_one", title: "worker d" });
  store.subscribeCohort("session_host", { sessionIds: ["session_a", "session_b", "session_d"] });
  a.complete("A finished.");
  store.updateSession("session_b", { settledOverride: "settled" });
  expect(woken(store)).toHaveLength(0);
  store.deleteSession("session_d");

  const [turn] = woken(store);
  expect(turn!.notification!.body).toContain('session_b "worker b" — settled before it reported');
  expect(turn!.notification!.body).toContain('session_d "worker d" — deleted before it reported');
});

test("a cohort closing while the host is busy waits for it to settle, as its own turn", () => {
  const { store } = setup();
  const a = start(store, "session_a", "run_a");
  store.subscribeCohort("session_host", { sessionIds: ["session_a"] });
  store.submitTurn("session_host", { runId: "run_host", input: "a long think" });
  const host = store.claimTurn("session_host", "worker_host")!.claim!.token;
  store.markRunning("session_host", "run_host", host);

  a.complete("A finished.");
  expect(store.turns("session_host").some((turn) => turn.notification?.cohortId)).toBe(false);
  expect(store.cohortsFor("session_host")[0]!.ready).toBe("all");

  store.completeTurn("session_host", "run_host", host, { text: "thought" });
  expect(woken(store).filter((turn) => turn.notification?.cohortId)).toHaveLength(1);
  expect(store.cohortsFor("session_host")).toHaveLength(0);
});

test("a member already idle on the host's finished errand is done at once", () => {
  const { store } = setup();
  const host = store.submitTurn("session_host", { runId: "run_host", input: "fan out" });
  const claim = store.claimTurn("session_host", "worker_host")!.claim!.token;
  store.markRunning("session_host", host.turn.runId, claim);
  store.submitAgentTurn("session_a", { runId: "run_task_a", input: "do A", intent: "task" }, { sessionId: "session_host", runId: "run_host", claimToken: claim });
  const child = store.claimTurn("session_a", "worker_child")!;
  store.markRunning("session_a", child.runId, child.claim!.token);
  store.completeTurn("session_a", child.runId, child.claim!.token, { text: "A was quick." });

  // session_b was never given anything by the host: pending.
  const cohort = store.subscribeCohort("session_host", { sessionIds: ["session_a", "session_b"] });
  expect(cohort.members.find((member) => member.sessionId === "session_a")).toMatchObject({ outcome: "completed", firstLine: "A was quick." });
  expect(cohort.members.find((member) => member.sessionId === "session_b")!.outcome).toBeUndefined();
});

test("unsubscribing takes a cohort id; a session cannot be in its own cohort", () => {
  const { store } = setup();
  const cohort = store.subscribeCohort("session_host", { sessionIds: ["session_a"] });
  expect(store.unsubscribe(cohort.id, "session_a")).toBe(false);
  expect(store.unsubscribe(cohort.id, "session_host")).toBe(true);
  expect(store.cohortsFor("session_host")).toHaveLength(0);
  expect(() => store.subscribeCohort("session_host", { sessionIds: ["session_host"] })).toThrow("its own cohort");
  expect(() => store.subscribeCohort("session_host", { sessionIds: ["session_a"], timeoutMinutes: 0 })).toThrow("timeoutMinutes");
});

test("the host reads as waiting while a cohort member is working", () => {
  const { store } = setup();
  start(store, "session_a", "run_a");
  store.subscribeCohort("session_host", { sessionIds: ["session_a"] });
  expect(store.getSession("session_host").activity).toBe("waiting");
});
