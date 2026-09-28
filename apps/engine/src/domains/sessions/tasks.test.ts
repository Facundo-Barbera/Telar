import { expect, test } from "bun:test";
import path from "node:path";
import { EngineStore } from "../../state";
import type { ExecutionStore } from "../../platform/db/execution-store";
import { useTempStores } from "../../../test/temp-store";

const { readyStore } = useTempStores();

const documents = (store: EngineStore) => (store as unknown as { kernel: { executionStore: ExecutionStore } }).kernel.executionStore;

test("tasks are journalled AND projected, so a cold session still knows a sub-agent ran", () => {
  const { store, root: stateRoot } = readyStore();
  store.intake.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  const claimed = store.claims.claimTurn("session_one", "worker_one")!;
  const token = claimed.claim!.token;
  store.turnLifecycle.markRunning("session_one", "run_one", token);

  store.ingest.ingestObservations("session_one", "run_one", token, [
    { kind: "task.started", task: { id: "task_a", kind: "agent", state: "running", title: "Audit the parser", role: "Explore" } },
    // A row produced INSIDE the sub-agent.
    { kind: "item.started", item: { id: "i1", detail: { type: "command_execution", command: { command: "rg x" } }, taskId: "task_a" } },
    // A patch naming only the state, exactly as `task_updated` sends it.
    { kind: "task.completed", task: { id: "task_a", kind: "agent", state: "completed", resultText: "found it" } },
  ]);

  const tasks = store.queries.tasks("session_one");
  expect(tasks).toHaveLength(1);
  expect(tasks[0]).toMatchObject({
    id: "task_a",
    sessionId: "session_one",
    runId: "run_one",
    state: "completed",
    resultText: "found it",
    // Carried through the terminal patch that never mentioned them.
    title: "Audit the parser",
    role: "Explore",
    completedAt: 100,
  });
  // The link survives into the stored item, which is the only way a client
  // opening this session LATER can file the row under its agent.
  expect(store.queries.items("session_one")[0]).toMatchObject({ id: "i1", taskId: "task_a" });
  expect(store.queries.readEvents("session_one").map((event) => event.type)).toEqual([
    "session.created",
    "turn.accepted",
    "turn.claimed",
    "turn.started",
    "task.started",
    "item.started",
    "task.completed",
  ]);
  // A stored projection beside the journal — not derived on read.
  expect(documents(store).read(path.join(stateRoot, "sessions/session_one/tasks.json"))).toMatchObject({ tasks: [{ id: "task_a" }] });
});

test("a close the level signal inferred yields to the notification that says the task failed", () => {
  /**
   * THE SDK SENDS THE LEVEL BEFORE THE BOOKEND. `background_tasks_changed`
   * closes a backgrounded agent as a bare `completed`; its `task_notification`
   * arrives a frame later saying `failed`. "The first ending is the ending"
   * would keep the green row — for an agent that failed.
   */
  const { store } = readyStore();
  store.intake.submitTurn("session_one", { runId: "run_one", input: "Fan out" });
  const claimed = store.claims.claimNextTurn("worker_one")!;
  const token = claimed.turn.claim!.token;
  store.turnLifecycle.markRunning("session_one", "run_one", token);
  const agent = { id: "task_agent", providerTaskId: "a1", kind: "agent" as const, backgrounded: true };
  store.ingest.ingestObservations("session_one", "run_one", token, [
    { kind: "task.started", task: { ...agent, state: "running" } },
    { kind: "task.completed", task: { ...agent, state: "completed" } },
    { kind: "task.completed", task: { ...agent, state: "failed", resultText: "could not reach the API" } },
  ]);
  expect(store.queries.tasks("session_one")[0]).toMatchObject({ state: "failed", resultText: "could not reach the API" });

  // A STATED ending is never rewritten: a completion that carried its result
  // stays completed whatever arrives after it.
  store.ingest.ingestObservations("session_one", "run_one", token, [
    { kind: "task.started", task: { ...agent, id: "task_other", providerTaskId: "a2", state: "running" } },
    { kind: "task.completed", task: { ...agent, id: "task_other", providerTaskId: "a2", state: "completed", resultText: "done" } },
    { kind: "task.completed", task: { ...agent, id: "task_other", providerTaskId: "a2", state: "stopped" } },
  ]);
  expect(store.queries.tasks("session_one").find((task) => task.id === "task_other")?.state).toBe("completed");
});

test("task reports between turns fold onto the rows they name, and open nothing", () => {
  const { store } = readyStore();
  store.intake.submitTurn("session_one", { runId: "run_one", input: "Watch it" });
  const first = store.claims.claimNextTurn("worker_one")!;
  const token = first.turn.claim!.token;
  store.turnLifecycle.markRunning("session_one", "run_one", token);
  store.ingest.ingestObservations("session_one", "run_one", token, [
    { kind: "task.started", task: { id: "task_toolu_bg", providerTaskId: "bg1", kind: "background", backgrounded: true, state: "running", title: "Wait for CI" } },
  ]);
  store.turnLifecycle.completeTurn("session_one", "run_one", token, { text: "Watching" });
  expect(store.records.get("session_one").activity).toBe("monitoring");

  // The shell ends while the session is idle: no claim, no turn.
  const accepted = store.ingest.reportSessionTasks("session_one", "worker_one", [
    { kind: "task.completed", task: { id: "task_toolu_bg", providerTaskId: "bg1", kind: "background", state: "completed", resultText: "green" } },
    // A row nobody opened is not minted here.
    { kind: "task.started", task: { id: "task_ghost", kind: "agent", state: "running" } },
  ]);
  expect(accepted).toEqual({ accepted: 1 });
  expect(store.queries.tasks("session_one")).toHaveLength(1);
  expect(store.queries.tasks("session_one")[0]).toMatchObject({ id: "task_toolu_bg", state: "completed", resultText: "green", runId: "run_one" });
  expect(store.records.get("session_one").activity).toBe("idle");
  expect(store.queries.readEvents("session_one").at(-1)).toMatchObject({ type: "task.completed", runId: "run_one" });
});

test("a claim carries the session's live task rows, and only those, as seeds", () => {
  const { store } = readyStore();
  store.intake.submitTurn("session_one", { runId: "run_one", input: "Watch it" });
  const first = store.claims.claimNextTurn("worker_one")!;
  const token = first.turn.claim!.token;
  store.turnLifecycle.markRunning("session_one", "run_one", token);
  store.ingest.ingestObservations("session_one", "run_one", token, [
    { kind: "task.started", task: { id: "task_toolu_ci", providerTaskId: "b7ohaj89n", kind: "background", backgrounded: true, state: "running", title: "Wait for CI" } },
    { kind: "task.started", task: { id: "task_toolu_done", providerTaskId: "x1", kind: "agent", state: "completed", title: "Explore" } },
  ]);
  store.turnLifecycle.completeTurn("session_one", "run_one", token, { text: "Watching" });

  store.intake.submitTurn("session_one", { runId: "run_two", input: "Next" });
  const second = store.claims.claimNextTurn("worker_one")!;
  // The seed is a `TaskSeed`: the engine-minted fields are stripped.
  expect(second.tasks).toEqual([
    { id: "task_toolu_ci", providerTaskId: "b7ohaj89n", kind: "background", backgrounded: true, state: "running", title: "Wait for CI" },
  ]);
});

test("a settled task is not re-announced by a report that adds nothing", () => {
  // A buffered report replayed about an already-closed task must not append another
  // completion event; a tailing client would fold it as a fresh one.
  const { store } = readyStore();
  store.intake.submitTurn("session_one", { runId: "run_one", input: "Watch it" });
  const first = store.claims.claimNextTurn("worker_one")!;
  const token = first.turn.claim!.token;
  store.turnLifecycle.markRunning("session_one", "run_one", token);
  store.ingest.ingestObservations("session_one", "run_one", token, [
    { kind: "task.started", task: { id: "task_toolu_mon", providerTaskId: "b7ohaj89n", kind: "background", state: "running", title: "Tick" } },
  ]);
  store.turnLifecycle.completeTurn("session_one", "run_one", token, { text: "Watching" });
  expect(store.worker.stopBackgroundTasks("session_one")).toBe(1);

  store.intake.submitTurn("session_one", { runId: "run_two", input: "Next" });
  const second = store.claims.claimNextTurn("worker_one")!;
  const token2 = second.turn.claim!.token;
  store.turnLifecycle.markRunning("session_one", "run_two", token2);
  // A bare restatement of the ending — the CLI's late `task_updated{killed}`.
  store.ingest.ingestObservations("session_one", "run_two", token2, [
    { kind: "task.completed", task: { id: "task_toolu_mon", providerTaskId: "b7ohaj89n", kind: "background", state: "stopped" } },
    { kind: "task.completed", task: { id: "task_b7ohaj89n", providerTaskId: "b7ohaj89n", kind: "agent", state: "completed" } },
  ]);
  const closes = () => store.queries.readEvents("session_one").filter((event) => event.type === "task.completed");
  expect(closes()).toHaveLength(1);
  // The summary the notification carries IS new — it lands on the row, but
  // a summary arriving a frame after the close is not a second close.
  store.ingest.ingestObservations("session_one", "run_two", token2, [
    { kind: "task.completed", task: { id: "task_b7ohaj89n", providerTaskId: "b7ohaj89n", kind: "agent", state: "completed", resultText: "tick 2" } },
  ]);
  expect(closes()).toHaveLength(1);
  expect(store.queries.tasks("session_one")).toHaveLength(1);
  expect(store.queries.tasks("session_one")[0]).toMatchObject({ id: "task_toolu_mon", kind: "background", state: "stopped", resultText: "tick 2" });
  // The log path rides the same late notification, and is folded the same way.
  store.ingest.ingestObservations("session_one", "run_two", token2, [
    { kind: "task.completed", task: { id: "task_b7ohaj89n", providerTaskId: "b7ohaj89n", kind: "background", state: "completed", outputFile: "/tmp/claude-501/p/s/tasks/b7ohaj89n.output" } },
  ]);
  expect(closes()).toHaveLength(1);
  expect(store.queries.tasks("session_one")[0]?.outputFile).toBe("/tmp/claude-501/p/s/tasks/b7ohaj89n.output");
});

test("a task's kind is decided once, and a later turn's partial report cannot downgrade it", () => {
  // A reaped shell is reported in the next turn with no type, which the seam reads as
  // an agent. Kind is fixed by the report that established it; the seed folds over it.
  const { store } = readyStore();
  store.intake.submitTurn("session_one", { runId: "run_one", input: "Start the dev server" });
  const first = store.claims.claimNextTurn("worker_one")!;
  const firstToken = first.turn.claim!.token;
  store.turnLifecycle.markRunning("session_one", "run_one", firstToken);
  store.ingest.ingestObservations("session_one", "run_one", firstToken, [
    { kind: "task.started", task: { id: "task_b", kind: "background", state: "running", title: "Start the dev server" } },
  ]);
  store.turnLifecycle.completeTurn("session_one", "run_one", firstToken, { text: "Started it" });
  expect(store.queries.tasks("session_one").find((task) => task.id === "task_b")).toMatchObject({ kind: "background" });

  // The next turn. The seam has no memory of task_b and says "agent".
  store.intake.submitTurn("session_one", { runId: "run_two", input: "anything" });
  const second = store.claims.claimNextTurn("worker_one")!;
  const secondToken = second.turn.claim!.token;
  store.turnLifecycle.markRunning("session_one", "run_two", secondToken);
  store.ingest.ingestObservations("session_one", "run_two", secondToken, [
    { kind: "task.completed", task: { id: "task_b", kind: "agent", state: "completed" } },
  ]);

  // A shell does not become a delegate by being reported late.
  expect(store.queries.tasks("session_one").find((task) => task.id === "task_b")).toMatchObject({ kind: "background" });
});

test("a backgrounded agent outlives its turn, and a later report cannot resurrect what was closed", () => {
  // Detached agents must not read failed when their turn ends, and a late progress line
  // must not spread a closed record under a running seed (failed and spinning at once).
  const { store } = readyStore();
  store.intake.submitTurn("session_one", { runId: "run_one", input: "Fan out" });
  const claim = store.claims.claimNextTurn("worker_one")!;
  const token = claim.turn.claim!.token;
  store.turnLifecycle.markRunning("session_one", "run_one", token);
  store.ingest.ingestObservations("session_one", "run_one", token, [
    { kind: "task.started", task: { id: "task_detached", kind: "agent", backgrounded: true, state: "running", title: "Explore, detached" } },
    { kind: "task.started", task: { id: "task_attached", kind: "agent", state: "running", title: "Explore, attached" } },
  ]);
  store.turnLifecycle.completeTurn("session_one", "run_one", token, { text: "Launched them" });

  const after = new Map(store.queries.tasks("session_one").map((task) => [task.id, task]));
  // The attached agent is swept — no process reports for it any more. The
  // detached one is spared exactly as a background shell would be — and, like
  // one, it reads as monitoring: the turn has ended, nothing is working in the
  // foreground.
  expect(after.get("task_attached")).toMatchObject({ state: "failed" });
  expect(after.get("task_detached")).toMatchObject({ state: "running", kind: "agent", backgrounded: true });
  expect(after.get("task_detached")?.failure).toBeUndefined();
  expect(store.records.get("session_one").activity).toBe("monitoring");

  // The next turn's driver has never heard of the sweep and reports the
  // ATTACHED agent (now closed) as still running. The first ending is the
  // ending: the record stays failed, and a report that adds nothing to a
  // settled row is not announced at all — neither as progress on a corpse
  // nor as a second completion.
  store.intake.submitTurn("session_one", { runId: "run_two", input: "Carry on" });
  const second = store.claims.claimNextTurn("worker_one")!;
  const secondToken = second.turn.claim!.token;
  store.turnLifecycle.markRunning("session_one", "run_two", secondToken);
  store.ingest.ingestObservations("session_one", "run_two", secondToken, [
    { kind: "task.progress", task: { id: "task_attached", kind: "agent", state: "running" }, message: "Reading a file" },
    { kind: "task.progress", task: { id: "task_detached", kind: "agent", backgrounded: true, state: "running" }, message: "Reading a file" },
  ]);
  const later = new Map(store.queries.tasks("session_one").map((task) => [task.id, task]));
  expect(later.get("task_attached")).toMatchObject({ state: "failed", failure: "the turn ended before this agent reported back" });
  expect(later.get("task_attached")?.completedAt).toBeDefined();
  const closes = store.queries.readEvents("session_one").filter((event) => event.type === "task.completed");
  expect(closes).toHaveLength(1);
  expect(store.queries.readEvents("session_one").at(-1)).toMatchObject({ type: "task.progress", task: { id: "task_detached" } });
  // The live one is live, still, with no failure riding along.
  expect(later.get("task_detached")).toMatchObject({ state: "running" });
  expect(later.get("task_detached")?.completedAt).toBeUndefined();
});

test("a later turn's report on a task it knows only by provider id folds onto the existing row", () => {
  // A notification carrying only the provider task id must fold onto the row announced
  // under the tool id, not mint a second row on the Agents surface.
  const { store } = readyStore();
  store.intake.submitTurn("session_one", { runId: "run_one", input: "Watch" });
  const first = store.claims.claimNextTurn("worker_one")!;
  store.turnLifecycle.markRunning("session_one", "run_one", first.turn.claim!.token);
  store.ingest.ingestObservations("session_one", "run_one", first.turn.claim!.token, [
    { kind: "task.started", task: { id: "task_toolu_mon", kind: "background", state: "running", title: "Monitor", providerTaskId: "b7ohaj89n", backgrounded: true } },
  ]);
  store.turnLifecycle.completeTurn("session_one", "run_one", first.turn.claim!.token, { text: "armed" });
  expect(store.worker.stopBackgroundTasks("session_one")).toBe(1);

  store.intake.submitTurn("session_one", { runId: "run_two", input: "Next" });
  const second = store.claims.claimNextTurn("worker_one")!;
  store.turnLifecycle.markRunning("session_one", "run_two", second.turn.claim!.token);
  store.ingest.ingestObservations("session_one", "run_two", second.turn.claim!.token, [
    { kind: "task.completed", task: { id: "task_b7ohaj89n", kind: "agent", state: "completed", providerTaskId: "b7ohaj89n", resultText: "stream ended" } },
  ]);
  const tasks = store.queries.tasks("session_one");
  expect(tasks).toHaveLength(1);
  // The stopped ending stands; the kind stands; the summary still folds in.
  expect(tasks[0]).toMatchObject({ id: "task_toolu_mon", kind: "background", state: "stopped", resultText: "stream ended" });
});
