import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { Turn } from "@telar/engine-client";
import { EngineStore } from "../../state";
import { EngineStateError } from "../../platform/kernel";
import type { ExecutionStore } from "../../platform/db/execution-store";
import { useTempStores } from "../../../test/temp-store";

const { root, readyStore } = useTempStores();

const documents = (store: EngineStore) => (store as unknown as { kernel: { executionStore: ExecutionStore } }).kernel.executionStore;

// Rewrites a stored session_one document, as an older build left it.
function editDocument(store: EngineStore, stateRoot: string, name: string, edit: (value: any) => void): void {
  const file = path.join(stateRoot, "sessions", "session_one", name);
  const value = documents(store).read(file);
  edit(value);
  documents(store).write(file, value);
}

test("a request left open on an already-ended turn is retired at boot; one on an ambiguous turn is kept", () => {
  // Persisted histories from before requests were retired with their turn.
  const { store, root: stateRoot } = readyStore();
  store.lifecycle.updateSession("session_one", { runtimeMode: "approval-required" });
  store.intake.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  const token = store.claims.claimTurn("session_one", "worker_one")!.claim!.token;
  store.turnLifecycle.markRunning("session_one", "run_one", token);
  store.requestGate.open("session_one", "run_one", token, {
    requestId: "req_stale",
    kind: "command_execution",
    detail: { kind: "command_execution", command: { command: "sleep 180" } },
  });
  // Fail the turn behind the store's back, as an older build did: the
  // request stays open on disk beside a failed turn.
  editDocument(store, stateRoot, "queue.json", (queue) => {
    Object.assign(queue.turns[0], { state: "failed", completedAt: 90, failure: { code: "driver_failed", message: "old build" } });
  });
  store.kernel.executionStore.close();

  const reopened = new EngineStore(stateRoot, () => 200);
  // Read alone already refuses to call the session blocked...
  expect(reopened.records.get("session_one").activity).toBe("idle");
  // ...and the boot sweep retires the request durably.
  reopened.recovery.recover();
  expect(reopened.requestGate.list("session_one")[0]).toMatchObject({ id: "req_stale", state: "resolved", resolvedBy: "cancelled", resolvedAt: 200 });
  expect(reopened.recovery.recover()).toEqual({ stopped: [] });
  expect(reopened.queries.readEvents("session_one").filter((event) => event.type === "request.resolved")).toHaveLength(1);

  // A restart is a stop: the interrupted turn is terminal, and its question, which no answer can reach, is cancelled.
  const other = readyStore().store;
  other.lifecycle.updateSession("session_one", { runtimeMode: "approval-required" });
  other.intake.submitTurn("session_one", { runId: "run_amb", input: "Hello" });
  const ambToken = other.claims.claimTurn("session_one", "worker_one")!.claim!.token;
  other.turnLifecycle.markRunning("session_one", "run_amb", ambToken);
  other.requestGate.open("session_one", "run_amb", ambToken, {
    requestId: "req_amb",
    kind: "command_execution",
    detail: { kind: "command_execution", command: { command: "ls" } },
  });
  expect(other.recovery.recover()).toEqual({ stopped: ["run_amb"] });
  // Retired on the FIRST boot: the turn was still `running` when the request
  // sweep passed over it, so closing it only there would have cured this on no
  // boot at all.
  expect(other.requestGate.list("session_one")[0]).toMatchObject({ state: "resolved", resolvedBy: "cancelled" });
  expect(other.records.get("session_one").activity).not.toBe("blocked");
  // AND THE TURN IS DONE — terminal, with why it ended, and asking nobody for
  // a decision. Its text and items stay exactly where they were.
  expect(other.queries.turns("session_one")[0]).toMatchObject({ state: "stopped", stopReason: "engine_restart", input: "Hello" });
  // Nothing to resume and nothing to discard: the next message just runs.
  expect(other.intake.submitTurn("session_one", { runId: "run_next", input: "carry on" }).turn.state).toBe("queued");
  expect(other.claims.claimTurn("session_one", "worker_two")?.runId).toBe("run_next");
});

test("a restart STOPS what it interrupted — claimed and running alike — and asks nobody to decide", () => {
  /**
   * A restart is a stop. This used to be two different endings that both
   * needed a person: merely-claimed work went back to `queued` and ran again
   * on its own (replay nobody asked for), and running work became `ambiguous`
   * and blocked the session until somebody pressed Continue or Discard.
   */
  const { store } = readyStore();
  store.intake.submitTurn("session_one", { runId: "claimed_turn", input: "Hello" });
  expect(store.claims.claimTurn("session_one", "worker_one")?.state).toBe("claimed");
  expect(store.recovery.recover()).toEqual({ stopped: ["claimed_turn"] });
  // NOT requeued. Going back to `queued` is what made a restart re-run work.
  expect(store.queries.turns("session_one")[0]).toMatchObject({ state: "stopped", stopReason: "engine_restart" });

  // And the same for work that had actually started.
  const { store: second } = readyStore();
  second.intake.submitTurn("session_one", { runId: "running_turn", input: "Hello" });
  const claimed = second.claims.claimTurn("session_one", "worker_one")!;
  second.turnLifecycle.markRunning("session_one", "running_turn", claimed.claim!.token);
  expect(second.recovery.recover()).toEqual({ stopped: ["running_turn"] });
  expect(second.queries.turns("session_one")[0]).toMatchObject({ state: "stopped", stopReason: "engine_restart" });

  // THE NEXT MESSAGE JUST RUNS. No decision gate, no discard first.
  expect(second.intake.submitTurn("session_one", { runId: "later_turn", input: "carry on from what you have" }).turn.state).toBe("queued");
  expect(second.claims.claimTurn("session_one", "worker_two")?.runId).toBe("later_turn");
  // Nothing is announced as ambiguous, because nothing is.
  expect(second.queries.readEvents("session_one").filter((event) => event.type === "turn.ambiguous")).toEqual([]);
  expect(second.queries.readEvents("session_one").filter((event) => event.type === "turn.stopped" && event.runId === "running_turn")).toHaveLength(1);
});

test("the boot sweep closes every terminal turn's leftovers in one pass over each document", () => {
  // The sweep closes leftovers once per session rather than per turn (a large store spent most of
  // its start doing the latter); the outcome must be identical: every turn's leftovers, one event each.
  const { store, root: stateRoot } = readyStore();
  // Otherwise the policy answers each request the moment it is asked, and there
  // is nothing left open for the sweep to retire.
  store.lifecycle.updateSession("session_one", { runtimeMode: "approval-required" });
  for (const runId of ["run_a", "run_b", "run_c"]) {
    store.intake.submitTurn("session_one", { runId, input: `work ${runId}` });
    const token = store.claims.claimTurn("session_one", "worker_one")!.claim!.token;
    store.turnLifecycle.markRunning("session_one", runId, token);
    store.ingest.ingestObservations("session_one", runId, token, [
      { kind: "item.started", item: { id: `item_${runId}`, detail: { type: "command_execution", command: { command: "sleep 60" } }, title: "sleep 60" } },
      { kind: "task.started", task: { id: `task_${runId}`, kind: "agent", state: "running", title: "helper" } },
    ]);
    store.requestGate.open("session_one", runId, token, {
      requestId: `req_${runId}`,
      kind: "command_execution",
      detail: { kind: "command_execution", command: { command: "sleep 180" } },
    });
    // End each turn behind the store's back, the way an older build's crash
    // left them: terminal on disk with its rows still open.
    editDocument(store, stateRoot, "queue.json", (queue) => {
      const turn = queue.turns.find((candidate: Turn) => candidate.runId === runId);
      Object.assign(turn, { state: "failed", completedAt: 90, failure: { code: "driver_failed", message: "old build" } });
    });
  }
  store.kernel.executionStore.close();

  const reopened = new EngineStore(stateRoot, () => 300);
  reopened.recovery.recover();

  // Every turn's item, task and request — not just the last one's.
  for (const runId of ["run_a", "run_b", "run_c"]) {
    expect(reopened.queries.items("session_one").find((item) => item.id === `item_${runId}`)).toMatchObject({ status: "failed", completedAt: 300 });
    expect(reopened.queries.tasks("session_one").find((task) => task.id === `task_${runId}`)).toMatchObject({ state: "failed" });
    expect(reopened.requestGate.list("session_one").find((request) => request.id === `req_${runId}`)).toMatchObject({ state: "resolved", resolvedBy: "cancelled", resolvedAt: 300 });
  }
  // One event each, and the run id on each event is the turn's own — a batched
  // sweep must not attribute one turn's closure to another.
  for (const runId of ["run_a", "run_b", "run_c"]) {
    const closures = reopened.queries.readEvents("session_one").filter((event) => event.type === "item.completed" && event.item.id === `item_${runId}`);
    expect(closures).toHaveLength(1);
    expect(closures[0]!.runId).toBe(runId);
  }
  // Idempotent: a second boot finds nothing open.
  expect(reopened.recovery.recover()).toEqual({ stopped: [] });
  expect(reopened.queries.readEvents("session_one").filter((event) => event.type === "request.resolved")).toHaveLength(3);
});

test("a fresh message needs no discard first — there is nothing to decide", () => {
  // A restart leaves nothing ambiguous, so `discardAmbiguousTurn` (kept for old clients) refuses
  // rather than pretending to settle something.
  const { store } = readyStore();
  store.intake.submitTurn("session_one", { runId: "uncertain_run", input: "Hello" });
  const claimed = store.claims.claimTurn("session_one", "worker_one");
  store.turnLifecycle.markRunning("session_one", "uncertain_run", claimed!.claim!.token);
  store.recovery.recover();

  expect(store.queries.turns("session_one")[0]).toMatchObject({ state: "stopped", stopReason: "engine_restart" });
  expect(() => store.turnLifecycle.discardAmbiguousTurn("session_one", "uncertain_run")).toThrow(EngineStateError);

  // The next message is accepted and claimable with no gesture in between.
  expect(store.intake.submitTurn("session_one", { runId: "fresh_run", input: "Hello" })).toMatchObject({
    replayed: false,
    turn: { runId: "fresh_run", state: "queued" },
  });
  expect(store.queries.turns("session_one").map((turn) => [turn.runId, turn.state])).toEqual([
    ["uncertain_run", "stopped"],
    ["fresh_run", "queued"],
  ]);
  expect(store.claims.claimTurn("session_one", "worker_two")?.runId).toBe("fresh_run");
});

test("startup recovery repairs provider continuity from a completed turn after an interrupted metadata write", () => {
  const { store, root: stateRoot } = readyStore();
  store.intake.submitTurn("session_one", { runId: "first", input: "Hello" });
  const claimed = store.claims.claimTurn("session_one", "worker_one")!;
  store.turnLifecycle.markRunning("session_one", "first", claimed.claim!.token);
  store.turnLifecycle.completeTurn("session_one", "first", claimed.claim!.token, { text: "Done", providerSessionId: "claude-session-one" });

  // queue.json is written before session.json, so a crash in that interval
  // leaves the terminal turn as the only record of the resume cursor.
  const metadataFile = path.join(stateRoot, "sessions", "session_one", "session.json");
  const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8")) as { resumeCursor?: string };
  delete metadata.resumeCursor;
  fs.writeFileSync(metadataFile, `${JSON.stringify(metadata)}\n`);

  const restarted = new EngineStore(stateRoot, () => 200);
  restarted.recovery.recover();
  expect(restarted.records.get("session_one").resumeCursor).toBe("claude-session-one");
  restarted.intake.submitTurn("session_one", { runId: "second", input: "Again" });
  expect(restarted.claims.claimNextTurn("worker_two")?.resumeCursor).toBe("claude-session-one");
});

test("the backlog is bounded, and an interrupted turn holds no dispatch at all", () => {
  const { store } = readyStore();
  store.intake.submitTurn("session_one", { runId: "run_one", input: "First" });
  const claimed = store.claims.claimTurn("session_one", "worker_one")!;
  store.turnLifecycle.markRunning("session_one", "run_one", claimed.claim!.token);

  // A runaway client with a fresh runId each time would otherwise grow
  // queue.json without bound, and the queue is rewritten whole per transition.
  for (let i = 0; i < 16; i += 1) store.intake.submitTurn("session_one", { runId: `run_q${i}`, input: "more" });
  expect(() => store.intake.submitTurn("session_one", { runId: "run_over", input: "one too many" })).toThrow(/maximum number of queued/);

  // AND NOTHING WAITS ON A DECISION. An interrupted turn used to hold the
  // session's dispatch until a human chose; it is terminal now, so the next
  // message is claimed as soon as it is written.
  const { store: other } = readyStore();
  other.intake.submitTurn("session_one", { runId: "run_a", input: "First" });
  const lost = other.claims.claimTurn("session_one", "worker_one")!;
  other.turnLifecycle.markRunning("session_one", "run_a", lost.claim!.token);
  other.recovery.recover();
  expect(other.intake.submitTurn("session_one", { runId: "run_b", input: "next" }).turn.state).toBe("queued");
  expect(other.claims.claimTurn("session_one", "worker_two")?.runId).toBe("run_b");
});

test("work queued BEFORE the crash is STOPPED, not replayed and not held", () => {
  // No replay, bought by ending the message rather than holding it: nothing waits on a person,
  // nothing runs on its own, and the words stay in the transcript to send again.
  const { store, root: stateRoot } = readyStore();
  store.intake.submitTurn("session_one", { runId: "run_lost", input: "Refactor" });
  const claim = store.claims.claimTurn("session_one", "worker_one")!;
  store.turnLifecycle.markRunning("session_one", "run_lost", claim.claim!.token);
  // One written while the turn ran (steered) and one plain queued behind it.
  store.intake.submitTurn("session_one", { runId: "run_steered", input: "and the tests" });
  expect(store.queries.turns("session_one").find((turn) => turn.runId === "run_steered")?.state).toBe("steering");

  const rebooted = new EngineStore(stateRoot, () => 200);
  expect(rebooted.recovery.recover().stopped.sort()).toEqual(["run_lost", "run_steered"]);
  for (const runId of ["run_lost", "run_steered"]) {
    const turn = rebooted.queries.turns("session_one").find((candidate) => candidate.runId === runId)!;
    expect(turn).toMatchObject({ state: "stopped", stopReason: "engine_restart" });
    // Not held: a hold is a question, and there is no question.
    expect(turn.held).toBeUndefined();
  }
  // THE TEXT SURVIVES. Nothing is deleted by being cancelled.
  expect(rebooted.queries.turns("session_one").find((turn) => turn.runId === "run_steered")?.input).toBe("and the tests");
  // Nothing dispatches on its own — there is nothing left to dispatch.
  expect(rebooted.claims.claimNextTurn("worker_two")).toBeUndefined();
});

test("a restart settles ONLY the sessions that had work — others are untouched", () => {
  // `recover()` walks every session, and an earlier draft of this sweep read a
  // cross-session accumulator, which would have swept the queue of every
  // session processed after the first unlucky one.
  const stateRoot = root();
  const store = new EngineStore(stateRoot, () => 100);
  store.projectRegistry.register({ id: "project_one", name: "One", root: "/tmp" });
  store.lifecycle.createSession({ id: "session_lost", projectId: "project_one" });
  store.lifecycle.createSession({ id: "session_fine", projectId: "project_one" });
  store.intake.submitTurn("session_lost", { runId: "run_lost", input: "Refactor" });
  const claim = store.claims.claimTurn("session_lost", "worker_one")!;
  store.turnLifecycle.markRunning("session_lost", "run_lost", claim.claim!.token);
  store.intake.submitTurn("session_lost", { runId: "run_behind", input: "before the crash" });
  store.intake.submitTurn("session_fine", { runId: "run_untouched", input: "nothing happened here" });

  const rebooted = new EngineStore(stateRoot, () => 200);
  const { stopped } = rebooted.recovery.recover();
  // Every session's pending work is settled, the idle one's too; isolation is about the journal:
  // each session records only its own runIds.
  expect(stopped.sort()).toEqual(["run_behind", "run_lost", "run_untouched"]);
  expect(rebooted.queries.turns("session_fine")[0]).toMatchObject({ runId: "run_untouched", state: "stopped", stopReason: "engine_restart" });
  // Nothing runs by itself afterwards, in either session.
  expect(rebooted.claims.claimNextTurn("worker_two")).toBeUndefined();
  // AND NEITHER SESSION CARRIES THE OTHER'S EVENTS. An earlier draft of this
  // sweep journalled a cross-session accumulator, which wrote the first
  // session's stops onto every session walked after it.
  const stops = (id: string) => rebooted.queries.readEvents(id).filter((event) => event.type === "turn.stopped").map((event) => event.runId).sort();
  expect(stops("session_lost")).toEqual(["run_behind", "run_lost"]);
  expect(stops("session_fine")).toEqual(["run_untouched"]);
});

test("a fresh message continues the conversation from the provider cursor, never replaying the lost prompt", () => {
  // What the cockpit's Continue used to drive, now with no gesture at all: say
  // something NEW and it resumes the same provider thread. The transcript and
  // the cursor both survive, and the original prompt is never resent.
  const { store, root: stateRoot } = readyStore();
  store.intake.submitTurn("session_one", { runId: "run_lost", input: "Refactor the parser and run the tests" });
  const claim = store.claims.claimTurn("session_one", "worker_one")!;
  store.turnLifecycle.markRunning("session_one", "run_lost", claim.claim!.token);
  store.ingest.ingestObservations("session_one", "run_lost", claim.claim!.token, [
    { kind: "provider.session", providerSessionId: "provider-thread-abc" },
    { kind: "item.started", item: { id: "msg_1", detail: { type: "assistant_message", text: "Reading the parser…" } } },
    { kind: "item.completed", itemId: "msg_1", status: "completed" },
  ]);

  const rebooted = new EngineStore(stateRoot, () => 200);
  rebooted.recovery.recover();
  rebooted.intake.submitTurn("session_one", { runId: "run_next", input: "What did you find?" });
  const claimed = rebooted.claims.claimNextTurn("worker_two");

  expect(claimed?.turn.input).toBe("What did you find?");
  expect(claimed?.resumeCursor).toBe("provider-thread-abc");
  // The lost run stays in the record, and so does everything it streamed.
  expect(rebooted.queries.turns("session_one")[0]).toMatchObject({ runId: "run_lost", state: "stopped", stopReason: "engine_restart" });
  expect(rebooted.queries.items("session_one").map((item) => item.id)).toContain("msg_1");
});

test("a vanished worker takes the session's background work with it — a task cannot outlive its process", () => {
  // A worker vanishing mid-turn is a process death, so its background shells close with it
  // instead of reading `running` forever.
  const { store } = readyStore();
  store.intake.submitTurn("session_one", { runId: "run_one", input: "Watch it" });
  const claim = store.claims.claimNextTurn("worker_one")!;
  const token = claim.turn.claim!.token;
  store.turnLifecycle.markRunning("session_one", "run_one", token);
  store.ingest.ingestObservations("session_one", "run_one", token, [
    { kind: "task.started", task: { id: "task_a", kind: "agent", state: "running", title: "Explore" } },
    { kind: "task.started", task: { id: "task_b", kind: "background", state: "running", title: "Tail the log" } },
  ]);

  store.recovery.retireWorkerRegistration("worker_one");

  // THE TURN'S OWN AGENT DIES WITH THE WORKER that was running it.
  const byId = new Map(store.queries.tasks("session_one").map((task) => [task.id, task]));
  expect(byId.get("task_a")).toMatchObject({ state: "failed", failure: "the worker running this agent disappeared" });
  // A retirement leaves background work alone: it outlives turns by definition, the engine
  // cannot see whether the process lives, and a broad sweep killed independent project services.
  expect(byId.get("task_b")?.state).toBe("running");
  // And the turn itself is terminal, so nothing replays and nothing blocks.
  expect(store.queries.turns("session_one")[0]).toMatchObject({ state: "stopped", stopReason: "worker_unavailable" });
});

test("an engine restart stops every session's background work — the idle-with-monitoring one too", () => {
  // The process is the unit: an engine restart kills an idle, monitoring session's CLI just as
  // surely as a busy one's, so its background work closes too.
  const { store, root: stateRoot } = readyStore();
  store.lifecycle.createSession({ id: "session_two", projectId: "project_one" });

  // session_one: RUNNING at the crash.
  store.intake.submitTurn("session_one", { runId: "run_one", input: "Watch it" });
  const first = store.claims.claimNextTurn("worker_one")!;
  store.turnLifecycle.markRunning("session_one", "run_one", first.turn.claim!.token);
  store.ingest.ingestObservations("session_one", "run_one", first.turn.claim!.token, [
    { kind: "task.started", task: { id: "task_b", kind: "background", state: "running", title: "Tail the log" } },
  ]);

  // session_two: idle-with-monitoring at the crash — its turn had settled,
  // its shell lived on in the worker's runtime, and the worker is gone.
  store.intake.submitTurn("session_two", { runId: "run_two", input: "Watch it too" });
  const second = store.claims.claimNextTurn("worker_one")!;
  store.turnLifecycle.markRunning("session_two", "run_two", second.turn.claim!.token);
  store.ingest.ingestObservations("session_two", "run_two", second.turn.claim!.token, [
    { kind: "task.started", task: { id: "task_c", kind: "background", state: "running", title: "Watch the build" } },
  ]);
  store.turnLifecycle.completeTurn("session_two", "run_two", second.turn.claim!.token, { text: "Watching" });
  expect(store.records.get("session_two").activity).toBe("monitoring");

  const restarted = new EngineStore(stateRoot, () => 200);
  restarted.recovery.recover();

  for (const [sessionId, taskId] of [["session_one", "task_b"], ["session_two", "task_c"]] as const) {
    expect(restarted.queries.tasks(sessionId).find((task) => task.id === taskId)).toMatchObject({
      state: "stopped",
      failure: "the process that owned this task is gone",
    });
  }
  expect(restarted.records.get("session_two").activity).toBe("idle");
  // Announced once. A second recover() finds nothing live and appends nothing.
  const closes = restarted.queries.readEvents("session_two").filter((event) => event.type === "task.completed");
  expect(closes).toHaveLength(1);
  restarted.recovery.recover();
  expect(restarted.queries.readEvents("session_two").filter((event) => event.type === "task.completed")).toHaveLength(1);
});

test("a shutdown mid-turn settles the message it was carrying — not held, not replayed", () => {
  /**
   * The old shape bought "do not replay" with a hold: the requeued steer was
   * marked `engine_restart` and waited for a human to re-read it. Ending it
   * buys the same guarantee without the waiting, and the words stay readable.
   */
  const { store, root: stateRoot } = readyStore();
  store.intake.submitTurn("session_one", { runId: "run_lost", input: "Refactor the parser" });
  const claim = store.claims.claimTurn("session_one", "worker_one")!;
  store.turnLifecycle.markRunning("session_one", "run_lost", claim.claim!.token);
  store.intake.submitTurn("session_one", { runId: "run_steer", input: "also update the docs" });
  expect(store.queries.turns("session_one")[1]?.state).toBe("steering");

  store.turnLifecycle.failTurn("session_one", "run_lost", claim.claim!.token, { code: "interrupted", message: "Telar shut down while this turn was running." });
  // The undelivered steer comes back to the queue — never lost.
  expect(store.queries.turns("session_one")[1]).toMatchObject({ state: "queued" });

  // The next boot settles it rather than holding it or running it.
  const rebooted = new EngineStore(stateRoot, () => 200);
  rebooted.recovery.recover();
  expect(rebooted.queries.turns("session_one")[1]).toMatchObject({ state: "stopped", stopReason: "engine_restart", input: "also update the docs" });
  expect(rebooted.claims.claimNextTurn("worker_two")).toBeUndefined();
  // And the person picks up by saying something, with no gesture first.
  rebooted.intake.submitTurn("session_one", { runId: "run_next", input: "carry on" });
  expect(rebooted.claims.claimNextTurn("worker_two")?.turn.runId).toBe("run_next");

  /**
   * AN ORDINARY FAILURE IS UNCHANGED. The person is there, watching, and the
   * session is left idle; the message they just typed running next is what
   * they expect.
   */
  const { store: crashed } = readyStore();
  crashed.intake.submitTurn("session_one", { runId: "run_crash", input: "Refactor" });
  const crashClaim = crashed.claims.claimTurn("session_one", "worker_one")!;
  crashed.turnLifecycle.markRunning("session_one", "run_crash", crashClaim.claim!.token);
  crashed.intake.submitTurn("session_one", { runId: "run_after", input: "and the docs" });
  crashed.turnLifecycle.failTurn("session_one", "run_crash", crashClaim.claim!.token, { code: "driver_failed", message: "the CLI died" });
  expect(crashed.queries.turns("session_one")[1]).toMatchObject({ state: "queued" });
  expect(crashed.queries.turns("session_one")[1]?.held).toBeUndefined();
  expect(crashed.claims.claimNextTurn("worker_two")?.turn.runId).toBe("run_after");
});

test("boot recovery reads the queues of unfinished sessions only, however long the history", () => {
  const { store, root: stateRoot } = readyStore();
  for (let n = 0; n < 200; n += 1) {
    store.lifecycle.createSession({ id: `session_done_${n}`, projectId: "project_one" });
    store.lifecycle.updateSession(`session_done_${n}`, { settledOverride: "settled" });
  }
  store.intake.submitTurn("session_one", { runId: "run_live", input: "Hello" });
  store.turnLifecycle.markRunning("session_one", "run_live", store.claims.claimTurn("session_one", "worker_one")!.claim!.token);
  store.kernel.executionStore.close();

  const reopened = new EngineStore(stateRoot, () => 200);
  reopened.recovery.cancellationsForWorker("worker_none");
  const before = reopened.kernel.readAccounting.queueParses;
  expect(reopened.recovery.recover().stopped).toEqual(["run_live"]);
  expect(reopened.kernel.readAccounting.queueParses - before).toBeLessThanOrEqual(3);
  expect(reopened.queries.turns("session_one")[0]).toMatchObject({ state: "stopped", stopReason: "engine_restart" });
});
