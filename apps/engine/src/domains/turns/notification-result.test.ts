import { afterEach, expect, test } from "bun:test";
import { MAX_DELIVERIES } from "./notification";
import { busy, closeStores, notifications, recordOf, reports, runTurn, setup } from "./notification-fixture";

afterEach(closeStores);

test("a result and its completion from one run reach the subscriber as ONE notification with both entries", () => {
  const { store } = setup();
  store.subscribe("session_host", { targetSessionId: "session_a" });
  const worker = reports(store);
  // The result is waiting in the host's queue, unread.
  expect(notifications(store)).toHaveLength(1);

  worker.end();

  const delivered = notifications(store);
  expect(delivered).toHaveLength(1);
  const detail = delivered[0]!.notification!;
  // The result leads: it names the call that fetches what was produced.
  expect(detail.kind).toBe("peer_message");
  expect(detail.intent).toBe("result");
  expect(detail.fetch).toEqual({ sessionId: "session_host", runId: worker.sent.runId });
  // And the completion survives: an errand never told its run ended never closes.
  expect(detail.entries?.map((entry) => entry.kind)).toEqual(["peer_message", "wake"]);
  expect(detail.entries?.at(-1)?.wakeKind).toBe("turn_completed");
  expect(detail.body).toContain("[wake: completed]");
  expect(detail.summary).toContain("(and 1 more)");
  // The notice was merged, the message was not.
  expect(delivered[0]!.input).toBe("Three commits landed: the parser, its tests, the changelog.");
  // One notice, and it is the one the model will be handed.
  expect(delivered[0]!.agentNotice).toBe(detail.body);
  // The transcript's row says what the turn says.
  const row = store.items("session_host").find((item) => item.runId === delivered[0]!.runId && item.detail.type === "notification")!;
  expect((row.detail as Extract<typeof row.detail, { type: "notification" }>).notification).toEqual(detail);
});

test("a result and a completion from DIFFERENT runs stay two facts", () => {
  const { store } = setup();
  store.subscribe("session_host", { targetSessionId: "session_a", once: false });
  const reporting = reports(store, { runId: "run_one" });
  reporting.end();
  expect(notifications(store)).toHaveLength(1);

  // A second run that sent nothing joins the queued turn as its own line.
  runTurn(store, "session_a", "run_two");

  const delivered = notifications(store);
  expect(delivered).toHaveLength(1);
  const detail = delivered[0]!.notification!;
  expect(detail.entries?.map((entry) => [entry.kind, entry.runId === "run_two"])).toEqual([
    ["peer_message", false],
    ["wake", false],
    ["wake", true],
  ]);
  expect(detail.runId).toBe("run_two");
  // The peer's words are still the turn's own.
  expect(delivered[0]!.input).toBe(reporting.sent.input);
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

test("a result the host has CLAIMED is not rewritten, and its completion is recorded rather than delivered", () => {
  const { store } = setup();
  store.subscribe("session_host", { targetSessionId: "session_a", once: true });
  const worker = reports(store);
  // Once claimed, the result is in front of a model and is never edited.
  const sent = notifications(store)[0]!;
  const token = store.claimTurn("session_host", "worker_host")!.claim!.token;
  store.markRunning("session_host", sent.runId, token);

  worker.end();

  expect(store.turns("session_host").find((turn) => turn.runId === sent.runId)!.notification!.entries).toBeUndefined();
  expect(store.pendingNotifications("session_host")).toHaveLength(0);
  // Recorded as a passive turn, completed on arrival, with a transcript row.
  const record = recordOf(store, worker.runId)!;
  expect(record).toMatchObject({
    state: "completed",
    origin: "session",
    agentDelivery: "passive",
    wakeReason: { kind: "turn_completed", sessionId: "session_a", runId: worker.runId },
  });
  expect(record.notification).toMatchObject({ kind: "wake", wakeKind: "turn_completed", runId: worker.runId });
  expect(record.notification!.body).toContain("[wake: completed]");
  expect(store.items("session_host").some((item) => item.runId === record.runId && item.detail.type === "notification")).toBe(true);
  // The ending is what spends the one-shot, exactly as on the delivered path.
  expect(store.subscriptionsFor("session_host")).toHaveLength(0);

  // And no second turn when the host settles.
  store.completeTurn("session_host", sent.runId, token, { text: "read it" });
  expect(store.turns("session_host").filter((turn) => turn.state === "queued")).toHaveLength(0);
  expect(store.claimTurn("session_host", "worker_host")).toBeUndefined();
});

// An awaited result is queued, so the ending that follows folds into it.
test("an awaited result to a BUSY host is queued, not steered, and its completion folds into it", () => {
  const { store } = setup();
  store.subscribe("session_host", { targetSessionId: "session_a", once: true });
  const host = busy(store);
  const worker = reports(store);
  expect(worker.sent).toMatchObject({ state: "queued", agentDelivery: "wake" });
  expect(store.steerForWorker("worker_host")).toHaveLength(0);

  worker.end();

  expect(store.pendingNotifications("session_host")).toHaveLength(0);
  expect(recordOf(store, worker.runId)).toBeUndefined();
  expect(store.subscriptionsFor("session_host")).toHaveLength(0);
  store.completeTurn("session_host", host.runId, host.token, { text: "done thinking" });
  const queued = store.turns("session_host").filter((turn) => turn.state === "queued");
  expect(queued).toHaveLength(1);
  expect(queued[0]!.runId).toBe(worker.sent.runId);
  expect(queued[0]!.notification!.entries?.map((entry) => entry.kind)).toEqual(["peer_message", "wake"]);
});

test("a run that FAILS after sending its result still wakes the host — that is actionable", () => {
  const { store } = setup();
  store.subscribe("session_host", { targetSessionId: "session_a" });
  const worker = reports(store);
  const sent = notifications(store)[0]!;
  const token = store.claimTurn("session_host", "worker_host")!.claim!.token;
  store.markRunning("session_host", sent.runId, token);

  store.failTurn("session_a", worker.runId, worker.token, { code: "driver_failed", message: "the CLI died" });

  expect(store.pendingNotifications("session_host").map((each) => each.wakeKind)).toEqual(["turn_failed"]);
  expect(recordOf(store, worker.runId)).toBeUndefined();
  store.completeTurn("session_host", sent.runId, token, { text: "read it" });
  const woken = store.turns("session_host").filter((turn) => turn.state === "queued");
  expect(woken).toHaveLength(1);
  expect(woken[0]!.notification!.wakeKind).toBe("turn_failed");
});

test("a completion from a run that sent NO result wakes exactly as before, even beside a read result", () => {
  const { store } = setup();
  store.subscribe("session_host", { targetSessionId: "session_a", once: false });
  const first = reports(store, { runId: "run_one" });
  const sent = notifications(store)[0]!;
  const token = store.claimTurn("session_host", "worker_host")!.claim!.token;
  store.markRunning("session_host", sent.runId, token);
  first.end();
  store.completeTurn("session_host", sent.runId, token, { text: "read it" });
  expect(recordOf(store, "run_one")).toBeDefined();

  // No result for this run, so the host is woken about it.
  runTurn(store, "session_a", "run_two");
  const woken = store.turns("session_host").filter((turn) => turn.state === "queued");
  expect(woken).toHaveLength(1);
  expect(woken[0]!.notification).toMatchObject({ wakeKind: "turn_completed", runId: "run_two" });
  expect(recordOf(store, "run_two")).toBeUndefined();
});

test("a completion after a sent result never interrupts, even under completionWake: always", () => {
  const { store } = setup();
  store.subscribe("session_host", { targetSessionId: "session_a", completionWake: "always" });
  const worker = reports(store);
  const sent = notifications(store)[0]!;
  const token = store.claimTurn("session_host", "worker_host")!.claim!.token;
  store.markRunning("session_host", sent.runId, token);

  worker.end();

  expect(store.turns("session_host").some((turn) => turn.state === "steering")).toBe(false);
  expect(recordOf(store, worker.runId)).toBeDefined();
});

test("a result nobody was awaiting stays held for the next turn — the completion after it is only recorded", () => {
  const { store } = setup();
  // Sent while busy and unsubscribed: passive, in the mailbox, never read by a model.
  const host = busy(store);
  const worker = reports(store);
  expect(worker.sent.agentDelivery).toBe("passive");
  store.subscribe("session_host", { targetSessionId: "session_a" });

  worker.end();

  // Peer mail never opens a turn of its own; it rides the next one.
  expect(recordOf(store, worker.runId)).toBeDefined();
  expect(store.pendingNotifications("session_host").map((each) => each.kind)).toEqual(["peer_message"]);
  store.completeTurn("session_host", host.runId, host.token, { text: "done" });
  expect(store.turns("session_host").filter((turn) => turn.state === "queued")).toHaveLength(0);
  expect(store.pendingNotifications("session_host").map((each) => each.kind)).toEqual(["peer_message"]);
});

test("the merge spends a delivery; a fresh errand joining the queued turn does not", () => {
  const { store } = setup();
  store.subscribe("session_host", { targetSessionId: "session_a", once: false, events: ["turn_completed", "turn_failed", "request_opened"] });
  const worker = reports(store);
  worker.end();
  const merged = notifications(store)[0]!;
  expect(merged.notification!.deliveries).toBe(MAX_DELIVERIES);

  // The cap is per errand, so a second result joins the queued turn.
  const second = reports(store, { runId: "run_two", sent: "and the changelog entry" });
  second.end();
  const rows = notifications(store).filter((turn) => turn.agentDelivery !== "passive");
  expect(rows).toHaveLength(1);
  expect(rows[0]!.notification!.deliveries).toBe(MAX_DELIVERIES);
  // Result, completion, second result; the second ending is only recorded.
  expect(rows[0]!.notification!.entries).toHaveLength(3);
  expect(store.pendingNotifications("session_host")).toHaveLength(0);
});

test("an `always` subscriber that is BUSY still gets its interruption rather than a merge", () => {
  const { store } = setup();
  // A driver without live steering queues a peer's message, so the host can be
  // busy and have an unread result waiting.
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
  // The send is passive, so nothing is queued for the failure to fold into.
  const host = busy(store);
  store.subscribe("session_host", { targetSessionId: "session_a", events: ["turn_failed"] });
  const worker = reports(store);
  expect(worker.sent.state).toBe("completed");
  store.failTurn("session_a", worker.runId, worker.token, { code: "driver_failed", message: "the CLI died" });
  // The host settling delivers both from the mailbox.
  store.completeTurn("session_host", host.runId, host.token, { text: "done" });
  const delivered = notifications(store).filter((turn) => turn.notification!.entries !== undefined);
  expect(delivered).toHaveLength(1);
  const kinds = delivered[0]!.notification!.entries!.map((entry) => entry.kind);
  expect(kinds).toEqual(["peer_message", "wake"]);
  expect(delivered[0]!.notification!.entries!.at(-1)!.wakeKind).toBe("turn_failed");
});
