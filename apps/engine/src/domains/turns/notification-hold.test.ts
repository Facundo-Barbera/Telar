import { afterEach, expect, test } from "bun:test";
import { MAX_DELIVERIES } from "./notification";
import { busy, closeStores, notifications, reopenStore, runTurn, setup } from "./notification-fixture";

afterEach(closeStores);

test("settled_only is the default: a wake at a busy subscriber is held, not steered", () => {
  const { store } = setup();
  store.subscribe("session_host", { targetSessionId: "session_a" });
  const host = busy(store);

  runTurn(store, "session_a", "run_a");

  // Not steered: a running turn is when a notice costs the most context.
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

// Only a person, a task or a blocker steers into a running turn.
test("completionWake: always queues its wake at once, but no longer steers into the running turn", () => {
  const { store } = setup();
  store.subscribe("session_host", { targetSessionId: "session_a", completionWake: "always" });
  const host = busy(store);

  runTurn(store, "session_a", "run_a");

  expect(store.turns("session_host").find((turn) => turn.state === "steering")).toBeUndefined();
  expect(store.pendingNotifications("session_host")).toHaveLength(0);
  const queued = store.turns("session_host").filter((turn) => turn.state === "queued");
  expect(queued.map((turn) => turn.notification?.runId)).toEqual(["run_a"]);
  expect(store.turns("session_host").find((turn) => turn.runId === host.runId)!.state).toBe("running");
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

  const delivered = notifications(store);
  expect(delivered).toHaveLength(1);
  const detail = delivered[0]!.notification!;
  expect(detail.entries?.map((entry) => entry.runId)).toEqual(["run_a", "run_b1", "run_b2"]);
  // The newest leads: a client that ignores `entries` shows it.
  expect(detail.runId).toBe("run_b2");
  expect(detail.summary).toContain("and 2 more");
  // The bodies are not concatenated; that would spend the context the hold saves.
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

  // Two events about one run: a request parks, then the turn ends.
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

  // Different kinds of one run stay separate entries, so this asserts on the ending.
  const pending = store.pendingNotifications("session_host");
  expect(pending.some((each) => each.wakeKind === "turn_completed" && each.runId === "run_a")).toBe(true);

  store.completeTurn("session_host", host.runId, host.token, { text: "ok" });
  expect(notifications(store)).toHaveLength(1);
});

test("a waiting notification is re-announced at most twice; the third stays pending and pollable", () => {
  const { store } = setup();
  store.subscribe("session_host", { targetSessionId: "session_a", once: false });

  // Three facts about one run on an idle host: the cap alone bounds the rewrites.
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

  // The waiting turn is rewritten with the newer fact, keeping its place.
  park("req_c");
  const rewritten = store.turns("session_host").find((turn) => turn.runId === parked.runId)!;
  expect(rewritten.notification!.deliveries).toBe(MAX_DELIVERIES);
  expect(rewritten.notification!.requestId).toBe("req_c");
  expect(store.turns("session_host").filter((turn) => turn.notification !== undefined)).toHaveLength(1);

  // A third goes to the mailbox, where `sessions_status` reports it.
  store.resolveRequest("session_a", "req_b", { decision: "accept", answers: { req_b: "a" } });
  store.resolveRequest("session_a", "req_c", { decision: "accept", answers: { req_c: "a" } });
  store.completeTurn("session_a", "run_b", token, { text: "done" });

  const after = store.turns("session_host").find((turn) => turn.runId === parked.runId)!;
  expect(after.notification!.deliveries).toBe(MAX_DELIVERIES);
  expect(after.notification!.requestId).toBe("req_c");
  expect(store.pendingNotifications("session_host").map((each) => each.wakeKind)).toEqual(["turn_completed"]);
  expect(store.turns("session_host").filter((turn) => turn.notification !== undefined)).toHaveLength(1);
});

test("a cohort already waiting takes a fresh wake with it rather than queueing a second turn", () => {
  const { store } = setup();
  store.subscribe("session_host", { targetSessionId: "session_a", once: false });
  store.subscribe("session_host", { targetSessionId: "session_b", once: false });
  const host = busy(store);
  runTurn(store, "session_a", "run_a");
  store.completeTurn("session_host", host.runId, host.token, { text: "ok" });
  expect(notifications(store)).toHaveLength(1);

  // The notification turn is still queued, so the next wake joins it.
  runTurn(store, "session_b", "run_b");
  const delivered = notifications(store);
  expect(delivered).toHaveLength(1);
  expect(delivered[0]!.notification!.entries?.map((entry) => entry.runId)).toEqual(["run_a", "run_b"]);
  expect(delivered[0]!.notification!.runId).toBe("run_b");
});

test("two children finishing a moment apart on an idle host make ONE queued turn", () => {
  const { store } = setup();
  store.subscribe("session_host", { targetSessionId: "session_a" });
  store.subscribe("session_host", { targetSessionId: "session_b" });

  runTurn(store, "session_a", "run_a");
  runTurn(store, "session_b", "run_b", "fail");

  const delivered = notifications(store);
  expect(delivered).toHaveLength(1);
  const detail = delivered[0]!.notification!;
  expect(detail.entries?.map((entry) => [entry.sessionId, entry.wakeKind])).toEqual([
    ["session_a", "turn_completed"],
    ["session_b", "turn_failed"],
  ]);
  // The turn is stamped by the newest, and its row says what the turn says.
  expect(delivered[0]!.wakeReason).toMatchObject({ sessionId: "session_b", runId: "run_b" });
  const row = store.items("session_host").find((item) => item.runId === delivered[0]!.runId && item.detail.type === "notification")!;
  expect((row.detail as Extract<typeof row.detail, { type: "notification" }>).notification).toEqual(detail);

  // Once claimed it is in front of a model, and the next wake is news of its own.
  store.claimTurn("session_host", "worker_host");
  runTurn(store, "session_a", "run_a2");
  expect(store.pendingNotifications("session_host").map((each) => each.runId)).toEqual(["run_a2"]);
});

test("a newer fact about one run in a queued cohort replaces only that run's line", () => {
  const { store } = setup();
  store.subscribe("session_host", { targetSessionId: "session_a", once: false });
  store.subscribe("session_host", { targetSessionId: "session_b", once: false });

  runTurn(store, "session_b", "run_b");
  store.submitTurn("session_a", { runId: "run_a", input: "work" });
  const token = store.claimTurn("session_a", "worker_child")!.claim!.token;
  store.markRunning("session_a", "run_a", token);
  store.updateSession("session_a", { runtimeMode: "approval-required" });
  store.openRequest("session_a", "run_a", token, {
    requestId: "req_a",
    kind: "user_input",
    detail: { kind: "user_input", prompt: "Which?", fields: [{ key: "k", label: "K", kind: "choice", choices: ["x"] }] },
  });
  store.resolveRequest("session_a", "req_a", { decision: "accept", answers: { k: "x" } });
  store.completeTurn("session_a", "run_a", token, { text: "done" });

  const delivered = notifications(store);
  expect(delivered).toHaveLength(1);
  expect(delivered[0]!.notification!.entries?.map((entry) => [entry.runId, entry.wakeKind])).toEqual([
    ["run_b", "turn_completed"],
    ["run_a", "turn_completed"],
  ]);
});

// A report is held, and handed over as a claim note on the queued wake.
test("a peer's report to an idle host rides the wake already queued there, as a note", () => {
  const { store } = setup();
  store.subscribe("session_host", { targetSessionId: "session_a" });
  runTurn(store, "session_a", "run_a");

  store.submitTurn("session_b", { runId: "run_b", input: "work" });
  const claim = store.claimTurn("session_b", "worker_child")!.claim!;
  store.markRunning("session_b", "run_b", claim.token);
  const sent = store.submitAgentTurn("session_host", { runId: "run_msg", input: "found the bug", intent: "report" }, { sessionId: "session_b", runId: "run_b", claimToken: claim.token });
  expect(sent.turn.agentDelivery).toBe("passive");

  const woken = notifications(store).filter((turn) => turn.agentDelivery !== "passive");
  expect(woken).toHaveLength(1);
  expect(woken[0]!.notification!.entries).toBeUndefined();
  expect(store.pendingNotifications("session_host").map((each) => each.runId)).toEqual(["run_msg"]);

  const next = store.claimNextTurn("worker_host")!;
  expect(next.turn.runId).toBe(woken[0]!.runId);
  expect(next.notes!.some((note) => note.startsWith("Held for you while you were busy") && note.includes("run_msg"))).toBe(true);
  expect(store.pendingNotifications("session_host")).toHaveLength(0);
  // The message itself is still on its own turn, whole, for sessions_read.
  expect(store.turns("session_host").find((turn) => turn.runId === "run_msg")!.input).toBe("found the bug");
});

test("a held notification survives a restart — it is a file, not a field on a live store", () => {
  const { store } = setup();
  store.subscribe("session_host", { targetSessionId: "session_a", once: false });
  const host = busy(store);
  runTurn(store, "session_a", "run_a");
  expect(store.pendingNotifications("session_host")).toHaveLength(1);

  const home = store.paths.root;
  store.closeExecutionStore();
  const reopened = reopenStore(home);
  expect(reopened.pendingNotifications("session_host").map((each) => each.runId)).toEqual(["run_a"]);
  // And the reopened store delivers it when the turn it was waiting on ends.
  reopened.completeTurn("session_host", host.runId, host.token, { text: "back" });
  expect(reopened.turns("session_host").filter((turn) => turn.notification !== undefined)).toHaveLength(1);
});

test("a peer's message is NOT held — it was addressed to this session, not fired at it", () => {
  const { store } = setup();
  // The hold applies to subscriptions; a `sessions_send` keeps its own delivery policy.
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
