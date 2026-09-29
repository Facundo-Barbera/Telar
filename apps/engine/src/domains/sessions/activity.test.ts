import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { useTempStores } from "../../../test/temp-store";

const { readyStore } = useTempStores();

test("a session says what it is doing, and a parked request outranks a running turn", () => {
  // THE FIELD THAT MAKES A LIST AN INBOX. Without it a sidebar can only sort by
  // recency — every row reads the same, and the two questions a person actually
  // has ("is one waiting on me", "is one still going") are unanswerable.
  const { store } = readyStore();
  expect(store.records.get("session_one").activity).toBe("idle");
  // Nothing to date on idle: how long ago it last did anything is `updatedAt`,
  // which every caller already has.
  expect(store.records.get("session_one").activityAt).toBeUndefined();

  store.intake.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  expect(store.records.get("session_one").activity).toBe("queued");

  const claim = store.claims.claimNextTurn("worker_one")!;
  store.turnLifecycle.markRunning("session_one", "run_one", claim.turn.claim!.token);
  expect(store.records.get("session_one").activity).toBe("working");

  // A mode that actually PARKS. Under the default posture this request
  // auto-resolves and the session stays "working", which is correct and is why
  // the mode has to be named here rather than assumed.
  store.lifecycle.updateSession("session_one", { runtimeMode: "approval-required" });
  store.requestGate.open("session_one", "run_one", claim.turn.claim!.token, {
    requestId: "req_one",
    kind: "command_execution",
    detail: { kind: "command_execution", command: { command: "rm -rf /" } },
  });
  // BOTH ARE TRUE AT ONCE — the turn is still running — and only one of them is
  // the reader's to act on. Decided in the engine so every client agrees.
  expect(store.records.get("session_one").activity).toBe("blocked");
  // And it dates the WAIT, not the turn: the number that should embarrass us.
  expect(store.records.get("session_one").activityAt).toBe(100);

  // Answering it hands the session back to the work it was doing.
  store.requestGate.resolve("session_one", "req_one", { decision: "accept" });
  expect(store.records.get("session_one").activity).toBe("working");
});

test("activity is derived on read and never written to disk", () => {
  // A stored "working" outlives the worker that was working: the next process
  // to open the file would report a turn nobody is running. Every write goes
  // through `storedSession`, so the field cannot reach the document.
  const { store, root: stateRoot } = readyStore();
  store.intake.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  const claim = store.claims.claimNextTurn("worker_one")!;
  store.turnLifecycle.markRunning("session_one", "run_one", claim.turn.claim!.token);
  expect(store.records.get("session_one").activity).toBe("working");

  // Force a metadata write while the turn is running, then read the raw file.
  store.lifecycle.updateSession("session_one", { title: "Renamed mid-turn" });
  const onDisk = JSON.parse(fs.readFileSync(path.join(stateRoot, "sessions", "session_one", "session.json"), "utf8"));
  expect("activity" in onDisk).toBe(false);
  expect("activityAt" in onDisk).toBe(false);
  expect("lastTurnEndedAt" in onDisk).toBe(false);
  expect("lastTurnFailed" in onDisk).toBe(false);
  // …and the derived answer survives the round trip unchanged.
  expect(store.records.get("session_one").activity).toBe("working");
});

test("a session reports when its last turn ended, and whether it ended badly", () => {
  // WHAT A SNOOZE NEEDS TO BE "NOT NOW" RATHER THAN "NEVER". A session can be
  // snoozed while a turn is running, so the work you deferred can finish while
  // the row is hidden — and a client with no way to notice would keep it hidden
  // until a wake time chosen before the answer existed.
  const { store } = readyStore();
  expect(store.records.get("session_one").lastTurnEndedAt).toBeUndefined();
  // Absent, never zero: no turn has ended is not "a turn ended at the epoch".
  expect(store.records.get("session_one").lastTurnFailed).toBeUndefined();

  store.intake.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  const first = store.claims.claimNextTurn("worker_one")!;
  store.turnLifecycle.markRunning("session_one", "run_one", first.turn.claim!.token);
  // Still running: nothing has ended yet.
  expect(store.records.get("session_one").lastTurnEndedAt).toBeUndefined();
  store.turnLifecycle.completeTurn("session_one", "run_one", first.turn.claim!.token, { text: "Done" });

  const completed = store.records.get("session_one");
  expect(completed.lastTurnEndedAt).toBe(completed.updatedAt);
  expect(completed.lastTurnFailed).toBeUndefined();

  // A LATER FAILURE REPLACES IT, and says so — a failure is not a state the
  // session is IN (it is idle again by now), it is something that happened.
  store.intake.submitTurn("session_one", { runId: "run_two", input: "Again" });
  const second = store.claims.claimNextTurn("worker_one")!;
  store.turnLifecycle.markRunning("session_one", "run_two", second.turn.claim!.token);
  store.turnLifecycle.failTurn("session_one", "run_two", second.turn.claim!.token, { code: "driver_failed", message: "boom" });

  const failed = store.records.get("session_one");
  expect(failed.activity).toBe("idle");
  // THE CLOCK IN THIS FIXTURE IS FROZEN, so both turns ended at the same
  // instant — which is the interesting case, not an artefact. Real timestamps
  // are milliseconds and two turns can finish inside one; a strict `>` kept the
  // EARLIER turn, so this assertion is what found it.
  expect(failed.lastTurnEndedAt).toBe(completed.lastTurnEndedAt!);
  expect(failed.lastTurnFailed).toBe(true);
});

test("once the turn ends, a backgrounded agent reads as monitoring, and paused or ambient work reads as nothing", () => {
  /**
   * THE COMPLAINT: a session whose turn had ended showed "Working" with its
   * clock running, because one sub-agent was launched with `run_in_background`
   * and `livenessOf` called any live agent working. Nothing was working in the
   * foreground; the turn was waiting on a child.
   */
  const { store } = readyStore();
  store.intake.submitTurn("session_one", { runId: "run_one", input: "Fan out" });
  const claimed = store.claims.claimNextTurn("worker_one")!;
  const token = claimed.turn.claim!.token;
  store.turnLifecycle.markRunning("session_one", "run_one", token);
  store.ingest.ingestObservations("session_one", "run_one", token, [
    { kind: "task.started", task: { id: "task_agent", providerTaskId: "a1", kind: "agent", backgrounded: true, state: "running", title: "Explore" } },
  ]);
  expect(store.records.get("session_one").activity).toBe("working");
  store.turnLifecycle.completeTurn("session_one", "run_one", token, { text: "Launched" });
  expect(store.records.get("session_one").activity).toBe("monitoring");

  // PAUSED is alive but not moving: the row says paused, so the badge must not
  // say busy.
  store.ingest.reportSessionTasks("session_one", "worker_one", [
    { kind: "task.progress", task: { id: "task_agent", providerTaskId: "a1", kind: "agent", backgrounded: true, state: "waiting" } },
  ]);
  expect(store.records.get("session_one").activity).toBe("idle");

  // AMBIENT is the provider's housekeeping, excluded from activity by the SDK.
  store.ingest.reportSessionTasks("session_one", "worker_one", [
    { kind: "task.progress", task: { id: "task_agent", providerTaskId: "a1", kind: "agent", backgrounded: true, ambient: true, state: "running" } },
  ]);
  expect(store.records.get("session_one").activity).toBe("idle");
});

test("background work is counted, agents apart from processes", () => {
  const { store } = readyStore();
  store.intake.submitTurn("session_one", { runId: "run_one", input: "Fan out" });
  const claimed = store.claims.claimNextTurn("worker_one")!;
  const token = claimed.turn.claim!.token;
  store.turnLifecycle.markRunning("session_one", "run_one", token);
  store.ingest.ingestObservations("session_one", "run_one", token, [
    { kind: "task.started", task: { id: "task_a", kind: "agent", backgrounded: true, state: "running" } },
    { kind: "task.started", task: { id: "task_b", kind: "agent", backgrounded: true, state: "running" } },
    { kind: "task.started", task: { id: "task_c", kind: "background", backgrounded: true, state: "running" } },
    // Neither of these is activity, so neither is counted.
    { kind: "task.started", task: { id: "task_d", kind: "background", backgrounded: true, state: "waiting" } },
    { kind: "task.started", task: { id: "task_e", kind: "background", backgrounded: true, ambient: true, state: "running" } },
  ]);
  store.turnLifecycle.completeTurn("session_one", "run_one", token, { text: "Launched" });
  expect(store.records.get("session_one")).toMatchObject({ activity: "monitoring", activityDetail: { kind: "background", tasks: 3, agents: 2 } });
});

test("a session subscribed to one that is still going reads as waiting on it — and only while it is", () => {
  /**
   * A coordinator that handed out work and ended its turn used to read `idle`,
   * the same as one that was finished. It is waiting on an answer that will
   * wake it.
   */
  const { store } = readyStore();
  store.lifecycle.createSession({ id: "session_two", projectId: "project_one", title: "Fix the parser" });
  const before = store.live.revision();
  store.subscriptions.subscribe("session_one", { targetSessionId: "session_two" });
  // Subscribing must redraw the subscriber's row.
  expect(store.live.revision()).toBeGreaterThan(before);
  // The target is doing nothing: the subscription promises nothing yet.
  expect(store.records.get("session_one").activity).toBe("idle");

  store.intake.submitTurn("session_two", { runId: "run_two", input: "Go" });
  expect(store.records.get("session_one")).toMatchObject({
    activity: "waiting",
    activityDetail: { kind: "session", sessionId: "session_two", title: "Fix the parser", sessions: 1 },
  });

  const claimed = store.claims.claimNextTurn("worker_one")!;
  store.turnLifecycle.markRunning("session_two", "run_two", claimed.turn.claim!.token);
  store.turnLifecycle.completeTurn("session_two", "run_two", claimed.turn.claim!.token, { text: "Done" });
  expect(store.records.get("session_one").activity).not.toBe("waiting");
});

test("a running turn whose only open call is a wait reads as waiting on it", () => {
  const { store } = readyStore();
  store.intake.submitTurn("session_one", { runId: "run_one", input: "Start the server and wait" });
  const claimed = store.claims.claimNextTurn("worker_one")!;
  const token = claimed.turn.claim!.token;
  store.turnLifecycle.markRunning("session_one", "run_one", token);
  store.ingest.ingestObservations("session_one", "run_one", token, [
    { kind: "item.started", item: { id: "wait", detail: { type: "mcp_tool_call", call: { name: "mcp__telar__run_wait", server: "telar" } } } },
  ]);
  expect(store.records.get("session_one")).toMatchObject({ activity: "working", activityDetail: { kind: "tool", waitingOn: "run" } });

  // Something else open alongside it — the model still writing — is work.
  store.ingest.ingestObservations("session_one", "run_one", token, [
    { kind: "item.started", item: { id: "text", detail: { type: "assistant_message", text: "" } } },
  ]);
  expect(store.records.get("session_one").activityDetail).toBeUndefined();
  store.ingest.ingestObservations("session_one", "run_one", token, [
    { kind: "item.completed", itemId: "text", status: "completed" },
    { kind: "item.completed", itemId: "wait", status: "completed" },
  ]);
  // Nothing open at all is a turn between steps, not a wait.
  expect(store.records.get("session_one")).toMatchObject({ activity: "working" });
  expect(store.records.get("session_one").activityDetail).toBeUndefined();
});

test("two sessions subscribed to each other fold without recursing", () => {
  const { store } = readyStore();
  store.lifecycle.createSession({ id: "session_two", projectId: "project_one" });
  store.subscriptions.subscribe("session_one", { targetSessionId: "session_two" });
  store.subscriptions.subscribe("session_two", { targetSessionId: "session_one" });
  store.intake.submitTurn("session_two", { runId: "run_two", input: "Go" });
  expect(store.records.get("session_one").activity).toBe("waiting");
  expect(store.records.get("session_two").activity).toBe("queued");
});

test("a session with live background work is not idle, and says which kind", () => {
  // A background task outlives the turn that started it, so activity cannot be derived
  // from the queue alone or those sessions read idle while the work goes on.
  const { store } = readyStore();
  store.intake.submitTurn("session_one", { runId: "run_one", input: "Watch it" });
  const claim = store.claims.claimNextTurn("worker_one")!;
  const token = claim.turn.claim!.token;
  store.turnLifecycle.markRunning("session_one", "run_one", token);
  store.ingest.ingestObservations("session_one", "run_one", token, [
    { kind: "task.started", task: { id: "task_b", kind: "background", state: "running", title: "Tail the log" } },
  ]);
  store.turnLifecycle.completeTurn("session_one", "run_one", token, { text: "Started the watcher" });

  // The queue is empty and the watcher is not.
  const monitoring = store.records.get("session_one");
  expect(monitoring.activity).toBe("monitoring");
  expect(monitoring.activityAt).toBe(100);

  // A LIVE AGENT OUTRANKS IT — `livenessOf`'s own rule, applied here rather
  // than restated: a fan-out mid-flight reads as working even while a log tail
  // is also running.
  store.intake.submitTurn("session_one", { runId: "run_two", input: "And fan out" });
  const second = store.claims.claimNextTurn("worker_one")!;
  const secondToken = second.turn.claim!.token;
  store.turnLifecycle.markRunning("session_one", "run_two", secondToken);
  store.ingest.ingestObservations("session_one", "run_two", secondToken, [
    { kind: "task.started", task: { id: "task_c", kind: "agent", state: "running", title: "Explore" } },
  ]);
  // A background task of its own does NOT get swept, so completing the turn
  // leaves the agent closed and the watcher alive.
  store.turnLifecycle.completeTurn("session_one", "run_two", secondToken, { text: "Done" });
  expect(store.records.get("session_one").activity).toBe("monitoring");

  // And once the watcher stops, the session is genuinely idle.
  store.intake.submitTurn("session_one", { runId: "run_three", input: "Stop it" });
  const third = store.claims.claimNextTurn("worker_one")!;
  const thirdToken = third.turn.claim!.token;
  store.turnLifecycle.markRunning("session_one", "run_three", thirdToken);
  store.ingest.ingestObservations("session_one", "run_three", thirdToken, [
    { kind: "task.completed", task: { id: "task_b", kind: "background", state: "completed" } },
  ]);
  store.turnLifecycle.completeTurn("session_one", "run_three", thirdToken, { text: "Stopped" });
  expect(store.records.get("session_one").activity).toBe("idle");
  expect(store.records.get("session_one").activityAt).toBeUndefined();
});

test("a session says who started its last ended turn, so an alert can tell the person's work from a wake", () => {
  const { store } = readyStore();
  const run = (runId: string, input: Omit<Parameters<typeof store.intake.submitTurn>[1], "runId">) => {
    store.intake.submitTurn("session_one", { ...input, runId });
    const claim = store.claims.claimNextTurn("worker_one")!;
    store.turnLifecycle.markRunning("session_one", runId, claim.turn.claim!.token);
    store.turnLifecycle.completeTurn("session_one", runId, claim.turn.claim!.token, { text: "Done" });
  };
  run("run_one", { input: "Hello" });
  expect(store.records.get("session_one").lastTurnOrigin).toBeUndefined();

  run("run_two", { input: "Woken", origin: "session", wakeReason: { kind: "turn_completed", sessionId: "session_two", runId: "run_x" } });
  expect(store.records.get("session_one").lastTurnOrigin).toBe("session");
});
