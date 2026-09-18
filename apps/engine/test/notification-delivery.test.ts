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

/**
 * A RESULT AND ITS COMPLETION ARE ONE ROW — issue #590 half 2.
 *
 * The owner's second complaint: "the agent gets the report and then the ping
 * that the agent finished". Two facts about one run, arriving seconds apart.
 * #240 keeps them two FACTS on purpose — suppressing the completion was tried
 * and reverted, because a worker sends a result for the part it finished and
 * keeps working, and an errand that is never told "the run has ended" never
 * closes. So these pin the MERGE and, just as hard, that the completion is
 * never lost.
 */

/** A worker's run that sends its coordinator a result and then ends. */
function reports(store: EngineStore, opts: { runId?: string; intent?: "result" | "report"; sent?: string } = {}) {
  const runId = opts.runId ?? "run_src";
  store.submitTurn("session_a", { runId, input: "work" });
  const token = store.claimTurn("session_a", "worker_child")!.claim!.token;
  store.markRunning("session_a", runId, token);
  const sent = store.submitAgentTurn(
    "session_host",
    { runId: `run_sent_${runId}`, input: opts.sent ?? "Three commits landed: the parser, its tests, the changelog.", intent: opts.intent ?? "result" },
    { sessionId: "session_a", runId, claimToken: token },
  );
  return { runId, token, sent: sent.turn, end: () => store.completeTurn("session_a", runId, token, { text: "done" }) };
}

test("a result and its completion from one run reach the subscriber as ONE notification with both entries", () => {
  const { store } = setup();
  store.subscribe("session_host", { targetSessionId: "session_a" });
  const worker = reports(store);
  // The result is waiting in the host's queue, unread — which is the whole
  // window this fold lives in.
  expect(notifications(store)).toHaveLength(1);

  worker.end();

  const delivered = notifications(store);
  expect(delivered).toHaveLength(1);
  const detail = delivered[0]!.notification!;
  // THE RESULT LEADS: it names the call that fetches what was produced, and a
  // row that led with "Session finished a turn" would have lost it.
  expect(detail.kind).toBe("peer_message");
  expect(detail.intent).toBe("result");
  expect(detail.fetch).toEqual({ sessionId: "session_host", runId: worker.sent.runId });
  // AND THE COMPLETION SURVIVES — the fact #240 reverted a suppression to keep.
  expect(detail.entries?.map((entry) => entry.kind)).toEqual(["peer_message", "wake"]);
  expect(detail.entries?.at(-1)?.wakeKind).toBe("turn_completed");
  expect(detail.body).toContain("[wake: completed]");
  expect(detail.summary).toContain("(and 1 more)");
  // The peer's own words are untouched: the notice was merged, the message was
  // not, and `sessions_read` still hands the body back whole.
  expect(delivered[0]!.input).toBe("Three commits landed: the parser, its tests, the changelog.");
  // One notice, and it is the one the model will be handed.
  expect(delivered[0]!.agentNotice).toBe(detail.body);
  // The transcript's row says what the turn says.
  const row = store.items("session_host").find((item) => item.runId === delivered[0]!.runId && item.detail.type === "notification")!;
  expect((row.detail as Extract<typeof row.detail, { type: "notification" }>).notification).toEqual(detail);
});

test("a result and a completion from DIFFERENT runs stay two", () => {
  const { store } = setup();
  store.subscribe("session_host", { targetSessionId: "session_a", once: false });
  const reporting = reports(store, { runId: "run_one" });
  reporting.end();
  expect(notifications(store)).toHaveLength(1);

  // A SECOND run of the same worker, ending without having sent anything. Same
  // session, different errand — and it lands while the merged result is still
  // waiting, so nothing but the key stops it being folded in under it.
  runTurn(store, "session_a", "run_two");

  const delivered = notifications(store);
  expect(delivered).toHaveLength(2);
  expect(delivered.find((turn) => turn.notification!.kind === "peer_message")!.notification!.entries).toHaveLength(2);
  expect(delivered.find((turn) => turn.notification!.kind === "wake")!.notification!.runId).toBe("run_two");
});

test("a completion with no preceding result is untouched", () => {
  const { store } = setup();
  store.subscribe("session_host", { targetSessionId: "session_a" });
  runTurn(store, "session_a", "run_a");
  const delivered = notifications(store);
  expect(delivered).toHaveLength(1);
  expect(delivered[0]!.notification!.kind).toBe("wake");
  expect(delivered[0]!.notification!.entries).toBeUndefined();
});

test("a result the host has ALREADY been handed is not rewritten under it", () => {
  const { store } = setup();
  store.subscribe("session_host", { targetSessionId: "session_a" });
  const worker = reports(store);
  // The host claimed the result: it is in front of a model now. Editing what a
  // recipient has been told is a worse failure than a second row, so the
  // completion arrives as its own notification.
  const sent = notifications(store)[0]!;
  const token = store.claimTurn("session_host", "worker_host")!.claim!.token;
  store.markRunning("session_host", sent.runId, token);

  worker.end();

  // Held rather than steered, because `settled_only` is the default — but held
  // as ITS OWN fact, not folded into the turn the host is reading.
  expect(store.pendingNotifications("session_host").map((each) => each.wakeKind)).toEqual(["turn_completed"]);
  expect(store.turns("session_host").find((turn) => turn.runId === sent.runId)!.notification!.entries).toBeUndefined();
  store.completeTurn("session_host", sent.runId, token, { text: "read it" });
  expect(notifications(store)).toHaveLength(2);
});

test("the merge spends a delivery, so a third fact about the run goes to the mailbox", () => {
  const { store } = setup();
  store.subscribe("session_host", { targetSessionId: "session_a", once: false, events: ["turn_completed", "turn_failed", "request_opened"] });
  const worker = reports(store);
  worker.end();
  const merged = notifications(store)[0]!;
  expect(merged.notification!.deliveries).toBe(MAX_DELIVERIES);

  // A SECOND run of the same worker, sending a second result — a fresh errand
  // with a delivery of its own, so the cap is about ONE row being rewritten
  // rather than about the worker.
  const second = reports(store, { runId: "run_two", sent: "and the changelog entry" });
  second.end();
  const rows = notifications(store);
  expect(rows).toHaveLength(2);
  expect(rows.every((turn) => turn.notification!.deliveries === MAX_DELIVERIES)).toBe(true);
});

test("an `always` subscriber that is BUSY still gets its interruption rather than a merge", () => {
  const { store } = setup();
  /**
   * The loud behaviour is opt-in and stays opt-in: folding a wake this
   * subscriber asked to be interrupted by into a turn still waiting in its
   * queue would quietly take that back.
   *
   * ON AN OPENCODE HOST, because that is the shape where this can happen at
   * all: a driver without live steering queues a peer's message instead of
   * steering it in, so the host can be busy AND have an unread result waiting.
   */
  store.createSession({ id: "session_slow", projectId: "project_one", title: "slow", driver: "opencode" });
  store.subscribe("session_slow", { targetSessionId: "session_a", completionWake: "always" });
  store.submitTurn("session_slow", { runId: "run_slow", input: "a long think" });
  const token = store.claimTurn("session_slow", "worker_slow")!.claim!.token;
  store.markRunning("session_slow", "run_slow", token);

  store.submitTurn("session_a", { runId: "run_src", input: "work" });
  const child = store.claimTurn("session_a", "worker_child")!.claim!.token;
  store.markRunning("session_a", "run_src", child);
  const sent = store.submitAgentTurn(
    "session_slow",
    { runId: "run_sent", input: "the analysis", intent: "result" },
    { sessionId: "session_a", runId: "run_src", claimToken: child },
  );
  expect(sent.turn.state).toBe("queued");

  store.completeTurn("session_a", "run_src", child, { text: "done" });

  // The ending queued on its own rather than riding the unread result.
  const rows = store.turns("session_slow").filter((each) => each.notification !== undefined);
  expect(rows).toHaveLength(2);
  expect(rows.find((each) => each.notification!.kind === "peer_message")!.notification!.entries).toBeUndefined();
  expect(rows.some((each) => each.notification!.wakeKind === "turn_completed")).toBe(true);
});

test("a passive report is never merged into — nothing was queued to merge", () => {
  const { store } = setup();
  // No `turn_completed` subscription when the result was sent, so the send was
  // passive: it completed on arrival and reached no model. A later wake must
  // arrive on its own or the failure is never announced at all.
  store.subscribe("session_host", { targetSessionId: "session_a", events: ["turn_failed"] });
  const worker = reports(store);
  expect(worker.sent.state).toBe("completed");
  store.failTurn("session_a", worker.runId, worker.token, { code: "driver_failed", message: "the CLI died" });
  const delivered = notifications(store).filter((turn) => turn.notification!.kind === "wake");
  expect(delivered).toHaveLength(1);
  expect(delivered[0]!.notification!.wakeKind).toBe("turn_failed");
});
