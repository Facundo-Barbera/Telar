/**
 * ASSIGNMENTS OVER THE REAL WIRE, against a real store — not a helper fold.
 *
 * The unit tests prove the fold. They cannot prove the thing that actually
 * matters: that a client asking for a WINDOW of a long session still gets a
 * complete, correctly-resolved assignment list, because the engine folded over
 * everything it holds rather than over the page it is about to send.
 *
 * So each case here builds a session whose carrier lies outside the requested
 * page, reads it through the daemon's HTTP surface, and asserts both halves —
 * the transcript IS windowed, and the assignments are NOT.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../src/daemon";
import { stubModels } from "./stub-models";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-assign-http-"));
  roots.push(directory);
  return directory;
};
afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function ready() {
  const daemon = await startEngine({ models: stubModels, engineRoot: root() });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: root() });
  await client.createSession({ id: "session_worker", projectId: "project_one" });
  await client.createSession({ id: "session_coord", projectId: "project_one" });
  await client.registerWorker("worker_one");
  return { daemon, client, store: daemon.store };
}

/** A task handed over with engine-stamped attribution, as `submitAgentTurn` does. */
function handOver(store: EngineDaemon["store"], runId: string, scope?: string) {
  return store.submitTurn("session_worker", {
    runId,
    input: "do the thing",
    origin: "session",
    sender: { sessionId: "session_coord" },
    agentIntent: "task",
    agentDelivery: "wake",
    agentSourceRunId: "coord_run_1",
    ...(scope ? { assignmentScope: scope } : {}),
  } as never);
}

/** Settle a turn so it leaves the unsettled set and becomes pageable. */
function settle(store: EngineDaemon["store"], sessionId: string, runId: string, state: "completed" | "stopped") {
  const queue = (store as never as { readQueue(id: string): { turns: { runId: string; state: string; completedAt?: number }[] } }).readQueue(sessionId);
  const turn = queue.turns.find((candidate) => candidate.runId === runId)!;
  turn.state = state;
  turn.completedAt = 5_000;
  (store as never as { writeQueue(id: string, queue: unknown): void }).writeQueue(sessionId, queue);
}

test("a CARRIER OUTSIDE THE PAGE still resolves to its real outcome", async () => {
  const { client, store } = await ready();

  // The carrier: an old, long-settled turn that a small window will not include.
  store.submitTurn("session_worker", { runId: "run_carrier", input: "older work" });
  settle(store, "session_worker", "run_carrier", "completed");

  // The task, steered into that carrier, then plenty of newer turns above it.
  handOver(store, "run_task", "engine only");
  settle(store, "session_worker", "run_task", "completed");
  const queue = (store as never as { readQueue(id: string): { turns: Record<string, unknown>[] } }).readQueue("session_worker");
  const task = queue.turns.find((turn) => turn.runId === "run_task")!;
  task.state = "steered";
  // `steer` requires `requestedAt`; a hand-built one must satisfy the schema
  // or the queue fails to parse on the next read.
  task.steer = { intoRunId: "run_carrier", requestedAt: 4_000, deliveredAt: 4_100 };
  (store as never as { writeQueue(id: string, q: unknown): void }).writeQueue("session_worker", queue);

  for (let index = 0; index < 6; index += 1) {
    store.submitTurn("session_worker", { runId: `run_newer_${index}`, input: `later ${index}` });
    settle(store, "session_worker", `run_newer_${index}`, "completed");
  }

  // A SMALL WINDOW: the transcript is paged and the carrier is not on it…
  const snapshot = await client.session("session_worker", { turns: 2 });
  expect(snapshot.turns.length).toBeLessThan(9);
  expect(snapshot.turns.some((turn) => turn.runId === "run_carrier")).toBe(false);
  expect(snapshot.page).toBeDefined();

  // …and the assignment is nonetheless complete and correctly resolved.
  const assignments = snapshot.assignments ?? [];
  expect(assignments).toHaveLength(1);
  expect(assignments[0]).toMatchObject({
    taskRunId: "run_task",
    fromSessionId: "session_coord",
    sourceRunId: "coord_run_1",
    scope: "engine only",
    runId: "run_carrier",
    outcome: "completed",
  });
  // NOT unknown — the engine held the carrier even though the page did not.
  expect(assignments[0]?.unresolved).toBeUndefined();
});

test("a TASK OUTSIDE THE PAGE with an ACTIVE carrier still reports outstanding", async () => {
  const { client, store } = await ready();

  // The task is old; the run it joined is still going.
  handOver(store, "run_task");
  const queue = (store as never as { readQueue(id: string): { turns: Record<string, unknown>[] } }).readQueue("session_worker");
  const task = queue.turns.find((turn) => turn.runId === "run_task")!;
  task.state = "steered";
  task.steer = { intoRunId: "run_live", requestedAt: 1, deliveredAt: 2 };
  task.completedAt = 1;
  (store as never as { writeQueue(id: string, q: unknown): void }).writeQueue("session_worker", queue);

  store.submitTurn("session_worker", { runId: "run_live", input: "the work" });
  for (let index = 0; index < 5; index += 1) {
    store.submitTurn("session_worker", { runId: `run_pad_${index}`, input: `pad ${index}` });
    settle(store, "session_worker", `run_pad_${index}`, "completed");
  }

  const snapshot = await client.session("session_worker", { turns: 1 });
  const assignments = snapshot.assignments ?? [];
  expect(assignments).toHaveLength(1);
  // Outstanding, named by the run doing the work — not by the task's own id.
  expect(assignments[0]).toMatchObject({ taskRunId: "run_task", runId: "run_live" });
  expect(assignments[0]?.outcome).toBeUndefined();
  expect(assignments[0]?.unresolved).toBeUndefined();
});

test("the LIVE LIST carries assignments, so a sidebar needs no per-session history read", async () => {
  const { client, store } = await ready();
  handOver(store, "run_task", "engine only");

  const live = await client.liveSessions();
  expect(live.assignments?.session_worker).toHaveLength(1);
  expect(live.assignments?.session_worker?.[0]).toMatchObject({
    fromSessionId: "session_coord",
    scope: "engine only",
  });
  // A session nobody handed work to contributes no entry at all, rather than an
  // empty array per row.
  expect(live.assignments?.session_coord).toBeUndefined();
});

test("a stopped assignment reports stopped over the wire, never a fake busy", async () => {
  const { client, store } = await ready();
  handOver(store, "run_task");
  settle(store, "session_worker", "run_task", "stopped");

  const [assignment] = (await client.session("session_worker")).assignments ?? [];
  expect(assignment).toMatchObject({ taskRunId: "run_task", outcome: "stopped" });
});

test("assignments SURVIVE A RESTART, because they are folded from durable turns", async () => {
  const { client, store, daemon } = await ready();
  handOver(store, "run_task", "engine only");
  const home = daemon.store.paths.root;
  await daemon.close();
  daemons.length = 0;

  const restarted = await startEngine({ models: stubModels, engineRoot: home });
  daemons.push(restarted);
  const next = new EngineClient(restarted.discovery);
  const [assignment] = (await next.session("session_worker")).assignments ?? [];
  expect(assignment).toMatchObject({ taskRunId: "run_task", fromSessionId: "session_coord", scope: "engine only" });
  void client;
});
