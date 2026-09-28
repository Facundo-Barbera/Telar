import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { Turn } from "@telar/engine-client";
import { EngineStateError, EngineStore } from "../../state";
import type { ExecutionStore } from "../../platform/db/execution-store";
import { useTempStores } from "../../../test/temp-store";

const { readyStore } = useTempStores();

const documents = (store: EngineStore) => (store as unknown as { kernel: { executionStore: ExecutionStore } }).kernel.executionStore;

// Rewrites a stored session_one document, as an older build left it.
function editDocument(store: EngineStore, stateRoot: string, name: string, edit: (value: any) => void): void {
  const file = path.join(stateRoot, "sessions", "session_one", name);
  const value = documents(store).read(file);
  edit(value);
  documents(store).write(file, value);
}

test("stop is durable and idempotent", () => {
  const { store } = readyStore();
  store.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  expect(store.stopTurn("session_one", "run_one").stopped).toBe(true);
  expect(store.turns("session_one")[0]?.state).toBe("stopped");
  expect(store.stopTurn("session_one", "run_one").stopped).toBe(false);
  expect(store.readEvents("session_one").at(-1)?.type).toBe("turn.stopped");
});

test("a stopped turn closes the tool row it was inside; a background task is left alone", () => {
  const { store } = readyStore();
  store.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  const token = store.claimTurn("session_one", "worker_one")!.claim!.token;
  store.markRunning("session_one", "run_one", token);
  store.ingestObservations("session_one", "run_one", token, [
    { kind: "item.started", item: { id: "shell", detail: { type: "command_execution", command: { command: "sleep 60" } }, title: "sleep 60" } },
    { kind: "item.started", item: { id: "done", detail: { type: "assistant_message", text: "ok" } } },
    { kind: "item.completed", itemId: "done", status: "completed" },
    { kind: "task.started", task: { id: "task_bg", kind: "background", state: "running", title: "watch", backgrounded: true } },
  ]);
  expect(store.stopTurn("session_one", "run_one").stopped).toBe(true);

  const byId = new Map(store.items("session_one").map((item) => [item.id, item]));
  expect(byId.get("shell")).toMatchObject({ status: "failed", completedAt: 100 });
  expect(byId.get("done")?.status).toBe("completed");
  expect(store.tasks("session_one").find((task) => task.id === "task_bg")?.state).toBe("running");
  const closes = store.readEvents("session_one").filter((event) => event.type === "item.completed" && event.item.id === "shell");
  expect(closes).toHaveLength(1);
  // Idempotent: a second sweep finds nothing open.
  expect(store.recover()).toEqual({ stopped: [] });
  expect(store.readEvents("session_one").filter((event) => event.type === "item.completed" && event.item.id === "shell")).toHaveLength(1);
});

test("discard cannot alter a non-ambiguous turn", () => {
  const { store } = readyStore();
  store.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  expect(() => store.discardAmbiguousTurn("session_one", "run_one")).toThrow(/only an ambiguous turn/);
  expect(store.turns("session_one")[0]).toMatchObject({ runId: "run_one", state: "queued" });
  expect(store.readEvents("session_one").map((event) => event.type)).toEqual(["session.created", "turn.accepted"]);
});

test("stopping a turn sweeps its sub-agents but SPARES background work", () => {
  // A turn's own sub-agents are swept on stop (one left running is a roster lie), but a
  // background task outlives its turn by definition: stop is the provider's interrupt, which spares it.
  const { store } = readyStore();
  store.submitTurn("session_one", { runId: "run_one", input: "Fan out" });
  const claim = store.claimNextTurn("worker_one")!;
  const token = claim.turn.claim!.token;
  store.markRunning("session_one", "run_one", token);
  store.ingestObservations("session_one", "run_one", token, [
    { kind: "task.started", task: { id: "task_a", kind: "agent", state: "running", title: "Explore" } },
    { kind: "task.started", task: { id: "task_b", kind: "background", state: "running", title: "Tail the log" } },
  ]);
  expect(store.getSession("session_one").activity).toBe("working");

  store.stopTurn("session_one", "run_one");

  const byId = new Map(store.tasks("session_one").map((task) => [task.id, task]));
  // The turn's own agent is swept — no process is running it any more.
  expect(byId.get("task_a")).toMatchObject({ state: "failed" });
  // The background task SURVIVES the turn Stop, exactly as it survives a normal
  // turn end — the interrupt spared it.
  expect(byId.get("task_b")).toMatchObject({ state: "running" });
  expect(store.readEvents("session_one").map((event) => event.type)).toContain("task.completed");
});

test("stop with nothing running settles lingering background work", () => {
  /**
   * THE RETROACTIVE CURE. A background task orphaned before the process-death
   * sweeps existed sits at `running` forever — the session reads "monitoring",
   * and Stop used to no-op because no turn was live. Now the press means the
   * only thing it can mean: settle whatever still claims to be working.
   */
  const { store } = readyStore();
  store.submitTurn("session_one", { runId: "run_one", input: "Watch it" });
  const claim = store.claimNextTurn("worker_one")!;
  const token = claim.turn.claim!.token;
  store.markRunning("session_one", "run_one", token);
  store.ingestObservations("session_one", "run_one", token, [
    { kind: "task.started", task: { id: "task_b", kind: "background", state: "running", title: "Tail the log" } },
  ]);
  store.completeTurn("session_one", "run_one", token, { text: "Started the watcher" });
  expect(store.getSession("session_one").activity).toBe("monitoring");

  const result = store.stopTurn("session_one");
  expect(result.stopped).toBe(true);
  const byId = new Map(store.tasks("session_one").map((task) => [task.id, task]));
  expect(byId.get("task_b")).toMatchObject({ state: "stopped", failure: "stopped from the cockpit" });
  expect(store.getSession("session_one").activity).toBe("idle");
  // A second press has nothing left to stop.
  expect(store.stopTurn("session_one").stopped).toBe(false);
});

describe("stop is stop — there is no pause to resume", () => {
  // Stop replaced a persistent pause: the live turn ends, the work behind it does not then
  // start, and nothing is deleted. What is gone is waiting for a Resume.
  function busy(): { store: EngineStore; token: string } {
    const { store } = readyStore();
    store.submitTurn("session_one", { runId: "run_live", input: "Long task" });
    const claimed = store.claimTurn("session_one", "worker_one")!;
    store.markRunning("session_one", "run_live", claimed.claim!.token);
    return { store, token: claimed.claim!.token };
  }

  test("stop ends the live turn AND settles what was queued behind it", () => {
    const { store } = busy();
    store.submitTurn("session_one", { runId: "run_steered", input: "also this" });
    store.pauseSession("session_one"); // the deprecated alias — same verb now
    const states = new Map(store.turns("session_one").map((turn) => [turn.runId, turn]));
    expect(states.get("run_live")).toMatchObject({ state: "stopped", stopReason: "user" });
    expect(states.get("run_steered")).toMatchObject({ state: "stopped", stopReason: "user" });
    // NOT held, and not requeued — requeueing is what made stop start the
    // next thing a heartbeat later.
    expect(states.get("run_steered")?.held).toBeUndefined();
    expect(store.claimTurn("session_one", "worker_two")).toBeUndefined();
  });

  test("and then the session is IDLE: the next message runs, with nothing to resume", () => {
    const { store } = busy();
    store.submitTurn("session_one", { runId: "run_queued", input: "waiting" });
    store.stopSession("session_one");
    expect(store.getSession("session_one").paused).toBeUndefined();
    // No gesture in between. This is the whole point.
    expect(store.submitTurn("session_one", { runId: "run_after", input: "carry on" }).turn.state).toBe("queued");
    expect(store.claimTurn("session_one", "worker_two")?.runId).toBe("run_after");
  });

  test("the words survive being cancelled — nothing is deleted", () => {
    const { store } = busy();
    store.submitTurn("session_one", { runId: "run_queued", input: "the thing I typed" });
    store.stopSession("session_one");
    expect(store.turns("session_one").find((turn) => turn.runId === "run_queued")).toMatchObject({
      state: "stopped",
      input: "the thing I typed",
    });
  });

  test("a DELIVERED steer stays steered: its words were part of the run", () => {
    // Cancelling it would be a lie about what the model saw.
    const { store, token } = busy();
    store.submitTurn("session_one", { runId: "run_heard", input: "heard this" });
    store.ackSteer("session_one", "run_heard", token);
    store.stopSession("session_one");
    expect(store.turns("session_one").find((turn) => turn.runId === "run_heard")?.state).toBe("steered");
  });

  test("stopping wakes a subscriber once — for the live turn, not once per cancelled message", () => {
    const { store } = readyStore();
    store.createSession({ id: "session_two", projectId: "project_one", title: "the worker" });
    store.subscribe("session_one", { targetSessionId: "session_two", events: ["turn_stopped"] });
    store.submitTurn("session_two", { runId: "run_live", input: "Long task" });
    const claimed = store.claimTurn("session_two", "worker_one")!;
    store.markRunning("session_two", "run_live", claimed.claim!.token);
    store.submitTurn("session_two", { runId: "run_q1", input: "one" });
    store.submitTurn("session_two", { runId: "run_q2", input: "two" });

    store.stopSession("session_two");
    const wakes = store.turns("session_one").filter((turn) => turn.origin === "session");
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.wakeReason).toMatchObject({ kind: "turn_stopped", sessionId: "session_two", runId: "run_live" });
  });

  test("an agent's stop is the person's stop — same verb, same result", () => {
    // `sessions_stop` used to mean pause, so an agent stopping a peer left it
    // latched while the Stop button did something else entirely.
    const { store } = busy();
    store.submitTurn("session_one", { runId: "run_q", input: "queued" });
    store.stopSession("session_one");
    expect(store.getSession("session_one").paused).toBeUndefined();
    expect(store.turns("session_one").find((turn) => turn.runId === "run_q")?.state).toBe("stopped");
  });

  for (const foreground of [true, false]) {
    test(`session Stop cancels background work with foreground=${foreground} and fences late reports`, () => {
      const { store, token } = busy();
      store.ingestObservations("session_one", "run_live", token, [
        { kind: "task.started", task: { id: "task_bg", kind: "background", state: "running", title: "Watch", providerTaskId: "provider_bg" } },
      ]);
      if (!foreground) store.completeTurn("session_one", "run_live", token, { text: "watching" });
      store.createSession({ id: "session_other", projectId: "project_one" });
      store.submitTurn("session_other", { runId: "run_other", input: "unrelated work" });
      const other = store.claimTurn("session_other", "worker_other")!;
      store.markRunning("session_other", "run_other", other.claim!.token);
      store.ingestObservations("session_other", "run_other", other.claim!.token, [
        { kind: "task.started", task: { id: "task_other", kind: "background", state: "running", title: "Other", providerTaskId: "provider_other" } },
      ]);

      store.stopSession("session_one");
      expect(store.tasks("session_one")[0]?.state).toBe("stopped");
      const queued = store.taskStopsForWorker("worker_one");
      expect(queued.map(({ sessionId, providerTaskId }) => ({ sessionId, providerTaskId }))).toEqual([{ sessionId: "session_one", providerTaskId: "provider_bg" }]);
      store.taskStopsForWorker("worker_one", queued.map((stop) => stop.deliveryId!));
      store.reportSessionTasks("session_one", "worker_one", [
        { kind: "task.progress", task: { id: "task_bg", kind: "background", state: "running", title: "late report" } },
      ]);
      expect(store.tasks("session_one")[0]?.state).toBe("stopped");
      expect(store.tasks("session_other")[0]?.state).toBe("running");
      store.stopSession("session_one");
      expect(store.taskStopsForWorker("worker_one")).toEqual([]);
      store.submitTurn("session_one", { runId: "run_after", input: "continue" });
      expect(store.claimTurn("session_one", "worker_one")?.runId).toBe("run_after");
    });
  }

  test("session Stop terminalizes legacy held work before clearing its pause latch", () => {
    const { store, root: directory } = readyStore();
    store.submitTurn("session_one", { runId: "run_held", input: "keep these words" });
    editDocument(store, directory, "queue.json", (queue) => { queue.turns[0].held = { at: 100, reason: "session_paused" }; });
    editDocument(store, directory, "session.json", (metadata) => { metadata.paused = { at: 100, by: "human" }; });
    store.closeExecutionStore();
    const legacy = new EngineStore(directory, () => 200);
    legacy.stopSession("session_one");
    expect(legacy.turns("session_one")[0]).toMatchObject({ state: "stopped", input: "keep these words" });
    expect(legacy.turns("session_one")[0]?.held).toBeUndefined();
    expect(legacy.getSession("session_one").paused).toBeUndefined();
    expect(legacy.claimTurn("session_one", "worker_one")).toBeUndefined();
    legacy.submitTurn("session_one", { runId: "run_after", input: "new instruction" });
    expect(legacy.claimTurn("session_one", "worker_one")?.runId).toBe("run_after");
  });

  test("stopping an idle session with nothing waiting changes nothing", () => {
    const { store } = readyStore();
    expect(store.stopSession("session_one")).toEqual({ stopped: [] });
  });

  test("a late completion cannot resurrect a stopped turn", () => {
    // The fence that makes stop mean stop even when the worker is mid-flight:
    // `completeTurn` takes only a RUNNING claim.
    const { store, token } = busy();
    store.stopSession("session_one");
    expect(() => store.completeTurn("session_one", "run_live", token, { text: "done" })).toThrow(EngineStateError);
    expect(store.turns("session_one")[0]?.state).toBe("stopped");
  });

  test("resume is inert: there is no latch to lift", () => {
    const { store } = busy();
    store.stopSession("session_one");
    expect(store.resumeSession("session_one")).toMatchObject({ released: 0, already: true });
  });
});

test("a turn that fails while parked on a question retires the question; the session is idle and recoverable", () => {
  // Reproduced live: the provider CLI was killed while inside AskUserQuestion.
  // The turn failed, but the request stayed open — sidebar "Waiting on you",
  // composer in answer mode, continuation unreachable.
  const { store } = readyStore();
  store.submitTurn("session_one", { runId: "run_one", input: "Write a checkpoint then wait" });
  const token = store.claimTurn("session_one", "worker_one")!.claim!.token;
  store.markRunning("session_one", "run_one", token);
  const asked = store.openRequest("session_one", "run_one", token, {
    requestId: "req_question",
    kind: "user_input",
    detail: { kind: "user_input", prompt: "Wait or continue?", fields: [{ key: "choice", label: "Choice", kind: "choice", choices: ["Wait", "Continue"] }] },
  });
  expect(asked.state).toBe("open");
  expect(store.getSession("session_one").activity).toBe("blocked");

  store.failTurn("session_one", "run_one", token, { code: "driver_failed", message: "Claude Code process terminated by signal SIGKILL" });

  const request = store.requests("session_one").find((candidate) => candidate.id === "req_question");
  expect(request).toMatchObject({ state: "resolved", decision: "cancel", resolvedBy: "cancelled", resolvedAt: 100 });
  expect(store.getSession("session_one")).toMatchObject({ activity: "idle", lastTurnFailed: true });
  expect(store.readEvents("session_one").filter((event) => event.type === "request.resolved" && event.requestId === "req_question")).toHaveLength(1);
  // Nothing left for a human to answer — and answering again is refused.
  expect(() => store.resolveRequest("session_one", "req_question", { decision: "accept" })).toThrow(/already been resolved/);
  // The next human turn is accepted: the session is not stuck behind the question.
  expect(store.submitTurn("session_one", { runId: "run_two", input: "Keep the existing checkpoint." }).turn.state).toBe("queued");
});

test("releasing checks the turn's state before its hold, and refuses a removed project", () => {
  /**
   * `releaseHeldTurn` is vestigial — nothing produces a hold any more — but it
   * is still reachable by an older client and by a queue.json written before
   * this change, so its guards still have to be right about a turn that is no
   * longer queued.
   */
  const { store, root: stateRoot } = readyStore();
  store.submitTurn("session_one", { runId: "run_lost", input: "Refactor" });
  const claim = store.claimTurn("session_one", "worker_one")!;
  store.markRunning("session_one", "run_lost", claim.claim!.token);
  store.submitTurn("session_one", { runId: "run_held", input: "before the crash" });
  store.closeExecutionStore();
  const rebooted = new EngineStore(stateRoot, () => 200);
  rebooted.recover();

  /**
   * THE STATE GUARD RAN ONLY WHEN THE TURN WAS UNHELD, so a terminal turn that
   * still carried a stale `held` flag skipped it — and was reported as
   * "released", which is a lie about a turn that has already ended.
   */
  editDocument(rebooted, stateRoot, "queue.json", (queue) => {
    Object.assign(queue.turns.find((turn: Turn) => turn.runId === "run_held"), { state: "stopped", completedAt: 150 });
  });
  rebooted.closeExecutionStore();
  const withStale = new EngineStore(stateRoot, () => 300);
  expect(() => withStale.releaseHeldTurn("session_one", "run_held")).toThrow(/only a queued turn can be released/);

  // Unreachable through the API today (a removed project cannot hold a queued turn), but releasing starts work,
  // so it keeps its own `assertProjectAvailable` gate. The state is written by hand.
  const { store: away, root: awayRoot } = readyStore();
  away.submitTurn("session_one", { runId: "run_held", input: "before the crash" });
  editDocument(away, awayRoot, "queue.json", (queue) => { queue.turns[0].held = { at: 100, reason: "engine_restart" }; });
  away.closeExecutionStore();
  const registryFile = path.join(awayRoot, "projects.json");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  registry.projects[0].removedAt = 150;
  fs.writeFileSync(registryFile, JSON.stringify(registry), "utf8");

  const awayBoot = new EngineStore(awayRoot, () => 300);
  expect(() => awayBoot.releaseHeldTurn("session_one", "run_held")).toThrow(/removed from Telar/);
  // ...and it is still held afterwards, rather than half-released by a throw.
  expect(awayBoot.turns("session_one")[0]?.held).toBeDefined();
});
