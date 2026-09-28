import { afterEach, expect, test } from "bun:test";
import { busy, closeStores, notifications, recordOf, reports, runTurn, setup } from "./notification-fixture";

afterEach(closeStores);

test("a held report, then the run's clean ending: one wake naming both", () => {
  const { store } = setup();
  store.subscriptions.subscribe("session_host", { targetSessionId: "session_a" });
  const worker = reports(store, { intent: "report" });
  expect(worker.sent.agentDelivery).toBe("passive");
  expect(notifications(store).filter((turn) => turn.state === "queued")).toHaveLength(0);

  worker.end();

  const queued = store.queries.turns("session_host").filter((turn) => turn.state === "queued");
  expect(queued).toHaveLength(1);
  expect(queued[0]!.notification!.entries?.map((entry) => [entry.kind, entry.wakeKind])).toEqual([
    ["peer_message", undefined],
    ["wake", "turn_completed"],
  ]);
  expect(recordOf(store, worker.runId)).toBeUndefined();
  expect(store.wakes.pendingNotifications("session_host")).toHaveLength(0);
});

test("a run that FAILS after a held report still wakes the host, carrying the report", () => {
  const { store } = setup();
  store.subscriptions.subscribe("session_host", { targetSessionId: "session_a" });
  const worker = reports(store, { intent: "report" });

  store.turnLifecycle.failTurn("session_a", worker.runId, worker.token, { code: "driver_failed", message: "the CLI died" });

  expect(recordOf(store, worker.runId)).toBeUndefined();
  const queued = store.queries.turns("session_host").filter((turn) => turn.state === "queued");
  expect(queued).toHaveLength(1);
  expect(queued[0]!.notification!.entries?.map((entry) => entry.kind)).toEqual(["peer_message", "wake"]);
  expect(queued[0]!.notification!.entries!.at(-1)!.wakeKind).toBe("turn_failed");
  expect(store.wakes.pendingNotifications("session_host")).toHaveLength(0);
});

test("a completion that said nothing — the background-claim turn — is recorded, not woken on", () => {
  const { store } = setup();
  store.subscriptions.subscribe("session_host", { targetSessionId: "session_a" });
  // The turn the driver opens to decide a tool call for background work.
  const claim = store.claims.openProviderTurn("session_a", { workerId: "worker_child", input: "", reason: { kind: "background_task", taskId: "task_toolu_bg" } });
  store.turnLifecycle.completeTurn("session_a", claim.runId, claim.claim!.token, { text: "Decided a tool call for background work still running after its turn ended." });

  expect(notifications(store).filter((turn) => turn.state === "queued")).toHaveLength(0);
  expect(recordOf(store, claim.runId)).toBeDefined();

  // Any other turn that journalled no text and sent nothing is the same.
  store.intake.submitTurn("session_a", { runId: "run_quiet", input: "work" });
  const token = store.claims.claimTurn("session_a", "worker_child")!.claim!.token;
  store.turnLifecycle.markRunning("session_a", "run_quiet", token);
  store.turnLifecycle.completeTurn("session_a", "run_quiet", token, { text: "" });
  expect(notifications(store).filter((turn) => turn.state === "queued")).toHaveLength(0);
  expect(recordOf(store, "run_quiet")).toBeDefined();

  // A turn that answered still wakes.
  runTurn(store, "session_a", "run_spoke");
  expect(notifications(store).filter((turn) => turn.state === "queued").map((turn) => turn.notification!.runId)).toEqual(["run_spoke"]);
});

// The report is held, so the result is the delivery and the report rides it as a note.
test("a report and a result from one run, before the host has started: one delivery, the report as its note", () => {
  const { store } = setup();
  store.subscriptions.subscribe("session_host", { targetSessionId: "session_a" });
  const worker = reports(store, { intent: "report", sent: "Parser done; tests next." });
  expect(worker.sent).toMatchObject({ state: "completed", agentDelivery: "passive" });
  const result = store.intake.submitAgentTurn(
    "session_host",
    { runId: "run_sent_second", input: "Tests pass. Done.", intent: "result" },
    { sessionId: "session_a", runId: worker.runId, claimToken: worker.token },
  );
  expect(result.turn).toMatchObject({ state: "queued", agentDelivery: "wake", input: "Tests pass. Done." });
  expect(store.wakes.pendingNotifications("session_host").map((each) => each.runId)).toEqual([worker.sent.runId]);

  // The clean ending folds into the waiting result.
  worker.end();
  const queued = store.queries.turns("session_host").filter((turn) => turn.state === "queued");
  expect(queued).toHaveLength(1);
  expect(queued[0]!.runId).toBe("run_sent_second");
  expect(queued[0]!.notification!.entries?.map((entry) => entry.kind)).toEqual(["peer_message", "wake"]);

  const claim = store.claims.claimNextTurn("worker_host")!;
  expect(claim.turn.runId).toBe("run_sent_second");
  expect(claim.notes!.some((note) => note.startsWith("Held for you while you were busy") && note.includes(worker.sent.runId))).toBe(true);
  expect(store.wakes.pendingNotifications("session_host")).toHaveLength(0);
});

test("a result held for a cohort also silences a plain subscription's completion", () => {
  const { store } = setup();
  store.subscriptions.subscribe("session_host", { targetSessionId: "session_a" });
  store.subscriptions.subscribeCohort("session_host", { sessionIds: ["session_a", "session_b"] });
  const worker = reports(store);
  expect(worker.sent.agentDelivery).toBe("passive");

  worker.end();

  expect(recordOf(store, worker.runId)).toBeDefined();
  expect(notifications(store).filter((turn) => turn.agentDelivery !== "passive")).toHaveLength(0);
});

test("after its result, a later turn on the same errand does not wake the host", () => {
  const { store } = setup();
  store.subscriptions.subscribe("session_host", { targetSessionId: "session_a", once: false });
  // The host's errand, then the result, read.
  const host = busy(store);
  store.intake.submitAgentTurn("session_a", { runId: "run_task", input: "do it", intent: "task" }, { sessionId: "session_host", runId: host.runId, claimToken: host.token });
  store.turnLifecycle.completeTurn("session_host", host.runId, host.token, { text: "dispatched" });
  const child = store.claims.claimTurn("session_a", "worker_child")!;
  store.turnLifecycle.markRunning("session_a", child.runId, child.claim!.token);
  store.intake.submitAgentTurn("session_host", { runId: "run_result", input: "PR green.", intent: "result" }, { sessionId: "session_a", runId: child.runId, claimToken: child.claim!.token });
  store.turnLifecycle.completeTurn("session_a", child.runId, child.claim!.token, { text: "Result sent." });
  const before = notifications(store).filter((turn) => turn.agentDelivery !== "passive").length;

  // A background wake on the worker, same errand, ends with words.
  runTurn(store, "session_a", "run_later");

  expect(notifications(store).filter((turn) => turn.agentDelivery !== "passive")).toHaveLength(before);
  expect(recordOf(store, "run_later")).toBeDefined();
});

test("a new errand resets it: the next run's completion without a result wakes as before", () => {
  const { store } = setup();
  store.subscriptions.subscribe("session_host", { targetSessionId: "session_a", once: false });
  const first = reports(store, { runId: "run_one" });
  first.end();
  // The host hands the worker something new.
  const host = store.claims.claimTurn("session_host", "worker_host")!;
  store.turnLifecycle.markRunning("session_host", host.runId, host.claim!.token);
  store.intake.submitAgentTurn("session_a", { runId: "run_task_two", input: "next", intent: "task" }, { sessionId: "session_host", runId: host.runId, claimToken: host.claim!.token });
  store.turnLifecycle.completeTurn("session_host", host.runId, host.claim!.token, { text: "sent" });
  const child = store.claims.claimTurn("session_a", "worker_child")!;
  store.turnLifecycle.markRunning("session_a", child.runId, child.claim!.token);
  store.turnLifecycle.completeTurn("session_a", child.runId, child.claim!.token, { text: "Stopped halfway." });

  expect(recordOf(store, child.runId)).toBeUndefined();
  expect(store.queries.turns("session_host").some((turn) => turn.state === "queued" && turn.notification?.runId === child.runId)).toBe(true);
});
