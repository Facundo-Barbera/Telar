/**
 * WHEN A NOTIFICATION LANDS, AND HOW MANY OF THEM LAND AT ONCE — issue #550
 * clause 3.
 *
 * The SHAPE of a notification is `agent-notice.test.ts`; the drivers' channels
 * are the per-driver files. What is under test here is the POLICY:
 *
 *   - `settled_only` is the default, so a wake arriving while the subscriber
 *     has a live turn is HELD rather than steered into the middle of its
 *     reasoning. `always` is the opt-in and still interrupts.
 *   - everything held for one session arrives as ONE notification listing it,
 *     rather than as four turns.
 *   - a waiting notification is re-announced at most once more; past that the
 *     newer fact stays PENDING and `sessions_status` is how it is found.
 *
 * Every one of those is about a coordinator's context, which is the resource a
 * fan-out actually spends.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore } from "../src/state";
import { MAX_DELIVERIES } from "../src/notification";

const homes: string[] = [];
const stores: EngineStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.closeExecutionStore();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

/** A coordinator and two workers it can subscribe to. */
function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-notify-"));
  homes.push(home);
  const store = new EngineStore(home, Date.now, { executionStorage: "sqlite" });
  stores.push(store);
  store.registerProject({ id: "project_one", name: "test", root: "/tmp" });
  for (const id of ["session_host", "session_a", "session_b"]) store.createSession({ id, projectId: "project_one", title: id });
  return { store };
}

/** Run one whole turn on `sessionId`, ending it the named way. */
function runTurn(store: EngineStore, sessionId: string, runId: string, end: "complete" | "fail" = "complete"): void {
  store.submitTurn(sessionId, { runId, input: "work" });
  const token = store.claimTurn(sessionId, "worker_child")!.claim!.token;
  store.markRunning(sessionId, runId, token);
  if (end === "complete") store.completeTurn(sessionId, runId, token, { text: "done" });
  else store.failTurn(sessionId, runId, token, { code: "driver_failed", message: "the CLI died" });
}

/** Make the host BUSY, and hand back the claim so a test can settle it. */
function busy(store: EngineStore, runId = "run_host"): { runId: string; token: string } {
  store.submitTurn("session_host", { runId, input: "a long think" });
  const token = store.claimTurn("session_host", "worker_host")!.claim!.token;
  store.markRunning("session_host", runId, token);
  return { runId, token };
}

const notifications = (store: EngineStore) => store.turns("session_host").filter((turn) => turn.notification !== undefined);

test("settled_only is the default: a wake at a busy subscriber is held, not steered", () => {
  const { store } = setup();
  store.subscribe("session_host", { targetSessionId: "session_a" });
  const host = busy(store);

  runTurn(store, "session_a", "run_a");

  // NOT STEERED. Before #550 this went straight into the running turn, which is
  // the one moment a notice costs most: a context already full of the work it
  // interrupted.
  expect(store.turns("session_host").find((turn) => turn.state === "steering")).toBeUndefined();
  expect(notifications(store)).toHaveLength(0);
  expect(store.pendingNotifications("session_host").map((each) => each.runId)).toEqual(["run_a"]);

  // Settling the host is what turns "not now" into "now".
  store.completeTurn("session_host", host.runId, host.token, { text: "thought about it" });
  const delivered = notifications(store);
  expect(delivered).toHaveLength(1);
  expect(delivered[0]!.notification!.runId).toBe("run_a");
  expect(delivered[0]!.notification!.body).toContain("[wake: completed]");
  expect(store.pendingNotifications("session_host")).toHaveLength(0);
});

test("completionWake: always is the opt-in, and still interrupts", () => {
  const { store } = setup();
  store.subscribe("session_host", { targetSessionId: "session_a", completionWake: "always" });
  busy(store);

  runTurn(store, "session_a", "run_a");

  expect(store.turns("session_host").find((turn) => turn.state === "steering")?.notification?.runId).toBe("run_a");
  expect(store.pendingNotifications("session_host")).toHaveLength(0);
});

test("re-subscribing changes the policy and leaves what it does not name", () => {
  const { store } = setup();
  store.subscribe("session_host", { targetSessionId: "session_a", events: ["turn_completed"], completionWake: "always" });
  const merged = store.subscribe("session_host", { targetSessionId: "session_a", events: ["turn_failed"] });
  // Omitting it keeps the choice already made — the rule `events` follows.
  expect(merged.completionWake).toBe("always");
  expect(merged.events.sort()).toEqual(["turn_completed", "turn_failed"]);
  expect(store.subscribe("session_host", { targetSessionId: "session_a", completionWake: "settled_only" }).completionWake).toBe("settled_only");
});

test("a default subscription stores no policy at all — absent IS settled_only", () => {
  const { store } = setup();
  // Not written into every subscription ever made: the default stays a reading
  // of the contract, so changing it later does not mean a migration.
  expect(store.subscribe("session_host", { targetSessionId: "session_a" }).completionWake).toBeUndefined();
});

test("everything held for one session arrives as ONE notification listing it", () => {
  const { store } = setup();
  store.subscribe("session_host", { targetSessionId: "session_a", once: false });
  store.subscribe("session_host", { targetSessionId: "session_b", once: false });
  const host = busy(store);

  runTurn(store, "session_a", "run_a");
  runTurn(store, "session_b", "run_b1");
  runTurn(store, "session_b", "run_b2", "fail");
  expect(store.pendingNotifications("session_host")).toHaveLength(3);

  store.completeTurn("session_host", host.runId, host.token, { text: "done thinking" });

  // ONE TURN, not three. A coordinator with three workers used to be woken
  // three times about work it had not looked at once.
  const delivered = notifications(store);
  expect(delivered).toHaveLength(1);
  const detail = delivered[0]!.notification!;
  expect(detail.entries?.map((entry) => entry.runId)).toEqual(["run_a", "run_b1", "run_b2"]);
  // THE NEWEST LEADS, because it is the one a reader acts on and the one a
  // client that ignores `entries` will show.
  expect(detail.runId).toBe("run_b2");
  expect(detail.summary).toContain("and 2 more");
  // THE BODIES ARE NOT CONCATENATED — three notices joined is three notices'
  // worth of context, which is the cost holding them was meant to avoid.
  expect(detail.body).toContain("3 things happened while this session was working");
  expect(detail.body.split("\n").filter((line) => /^\d\. /.test(line))).toHaveLength(3);
  expect(detail.body).toContain("None of this was typed by a person.");

  // And the transcript's row carries the same merged object.
  const row = store.items("session_host").find((item) => item.runId === delivered[0]!.runId && item.detail.type === "notification")!;
  expect((row.detail as Extract<typeof row.detail, { type: "notification" }>).notification).toEqual(detail);
});

test("two facts about ONE run collapse to the newest rather than piling up", () => {
  const { store } = setup();
  store.subscribe("session_host", { targetSessionId: "session_a", once: false });
  const host = busy(store);

  // The same run fails, having first been... completed is impossible, so use
  // two events about one run the way a real child produces them: a request
  // parks, then the turn ends.
  store.submitTurn("session_a", { runId: "run_a", input: "work" });
  const token = store.claimTurn("session_a", "worker_child")!.claim!.token;
  store.markRunning("session_a", "run_a", token);
  store.updateSession("session_a", { runtimeMode: "approval-required" });
  store.openRequest("session_a", "run_a", token, {
    requestId: "req_one",
    kind: "user_input",
    detail: { kind: "user_input", prompt: "Which database?", fields: [{ key: "db", label: "Database", kind: "choice", choices: ["postgres"] }] },
  });
  expect(store.pendingNotifications("session_host")).toHaveLength(1);
  store.resolveRequest("session_a", "req_one", { decision: "accept", answers: { db: "postgres" } });
  store.completeTurn("session_a", "run_a", token, { text: "done" });

  // ONE entry, and it is the ending — the parked request it superseded is not
  // worth a coordinator's attention once the turn it belonged to has ended.
  // Different KINDS of the same run are separate entries by design (a request
  // is actionable and an outcome is not), so this asserts on the ending.
  const pending = store.pendingNotifications("session_host");
  expect(pending.some((each) => each.wakeKind === "turn_completed" && each.runId === "run_a")).toBe(true);

  store.completeTurn("session_host", host.runId, host.token, { text: "ok" });
  expect(notifications(store)).toHaveLength(1);
});

test("a waiting notification is re-announced at most twice; the third stays pending and pollable", () => {
  const { store } = setup();
  store.subscribe("session_host", { targetSessionId: "session_a", once: false });

  // THREE FACTS ABOUT ONE RUN, which is exactly what a child that parks an
  // approval, parks another, and then finishes produces. The host stays IDLE
  // throughout, so each lands on the queued path and the cap is the only thing
  // bounding how often the waiting turn is rewritten.
  store.submitTurn("session_a", { runId: "run_b", input: "work" });
  const token = store.claimTurn("session_a", "worker_child")!.claim!.token;
  store.markRunning("session_a", "run_b", token);
  store.updateSession("session_a", { runtimeMode: "approval-required" });
  const park = (requestId: string) =>
    store.openRequest("session_a", "run_b", token, {
      requestId,
      kind: "user_input",
      detail: { kind: "user_input", prompt: "Which one?", fields: [{ key: requestId, label: "K", kind: "choice", choices: ["a"] }] },
    });

  park("req_b");
  const parked = store.turns("session_host").find((turn) => turn.notification?.runId === "run_b")!;
  expect(parked.notification!.deliveries).toBe(1);
  expect(parked.notification!.requestId).toBe("req_b");

  // DELIVERY TWO: the waiting turn is rewritten with the newer fact, keeping
  // its place in the queue.
  park("req_c");
  const rewritten = store.turns("session_host").find((turn) => turn.runId === parked.runId)!;
  expect(rewritten.notification!.deliveries).toBe(MAX_DELIVERIES);
  expect(rewritten.notification!.requestId).toBe("req_c");
  expect(store.turns("session_host").filter((turn) => turn.notification !== undefined)).toHaveLength(1);

  // A THIRD IS NOT ANNOUNCED AGAIN. It goes to the mailbox, where
  // `sessions_status` reports it — "we stopped pushing" only holds together
  // because there is a pull.
  store.resolveRequest("session_a", "req_b", { decision: "accept", answers: { req_b: "a" } });
  store.resolveRequest("session_a", "req_c", { decision: "accept", answers: { req_c: "a" } });
  store.completeTurn("session_a", "run_b", token, { text: "done" });

  const after = store.turns("session_host").find((turn) => turn.runId === parked.runId)!;
  expect(after.notification!.deliveries).toBe(MAX_DELIVERIES);
  // Unchanged: the turn keeps whatever it last said rather than being spent a
  // third time on an errand nobody has read.
  expect(after.notification!.requestId).toBe("req_c");
  expect(store.pendingNotifications("session_host").map((each) => each.wakeKind)).toEqual(["turn_completed"]);
  // Still only the one queued notification turn.
  expect(store.turns("session_host").filter((turn) => turn.notification !== undefined)).toHaveLength(1);
});

test("a cohort already waiting takes a fresh wake with it rather than queueing a second turn", () => {
  const { store } = setup();
  store.subscribe("session_host", { targetSessionId: "session_a", once: false });
  store.subscribe("session_host", { targetSessionId: "session_b", once: false });
  const host = busy(store);
  runTurn(store, "session_a", "run_a");
  // The host settles, but nothing has flushed the box yet in this instant —
  // simulate the window by holding one and firing another while idle.
  store.completeTurn("session_host", host.runId, host.token, { text: "ok" });
  expect(notifications(store)).toHaveLength(1);

  // Now idle with an empty box: the next wake queues on its own, as before.
  runTurn(store, "session_b", "run_b");
  expect(notifications(store)).toHaveLength(2);
});

test("a held notification survives a restart — it is a file, not a field on a live store", () => {
  const { store } = setup();
  store.subscribe("session_host", { targetSessionId: "session_a", once: false });
  const host = busy(store);
  runTurn(store, "session_a", "run_a");
  expect(store.pendingNotifications("session_host")).toHaveLength(1);

  const home = store.paths.root;
  store.closeExecutionStore();
  const reopened = new EngineStore(home);
  stores.push(reopened);
  expect(reopened.pendingNotifications("session_host").map((each) => each.runId)).toEqual(["run_a"]);
  // And the reopened store delivers it when the turn it was waiting on ends.
  reopened.completeTurn("session_host", host.runId, host.token, { text: "back" });
  expect(reopened.turns("session_host").filter((turn) => turn.notification !== undefined)).toHaveLength(1);
});

test("a peer's message is NOT held — it was addressed to this session, not fired at it", () => {
  const { store } = setup();
  // The hold is a property of SUBSCRIPTIONS: a wake is something a session
  // asked to be told about, and holding it costs nobody. A `sessions_send` is
  // one agent deliberately addressing another, and its delivery policy is its
  // own (`agentDelivery`, and the steer path) — unchanged by #550.
  store.submitTurn("session_a", { runId: "run_src", input: "work" });
  const token = store.claimTurn("session_a", "worker_child")!.claim!.token;
  store.markRunning("session_a", "run_src", token);
  busy(store);

  const { turn } = store.submitAgentTurn(
    "session_host",
    { runId: "run_sent", input: "please review the diff", intent: "task" },
    { sessionId: "session_a", runId: "run_src", claimToken: token },
  );
  expect(turn.state).toBe("steering");
  expect(store.pendingNotifications("session_host")).toHaveLength(0);
});
