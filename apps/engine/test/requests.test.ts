/**
 * Stage 2 — approvals end to end.
 *
 * The property under test is the one that decides whether a detached session
 * is autonomous or merely stuck: a request either resolves by policy without a
 * human, or parks visibly with someone told.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../src/daemon";
import { EngineStateError, EngineStore } from "../src/state";
import { EngineWorker } from "../src/worker";
import { normalizeOutcome, type TurnDriver } from "../src/driver";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];
const workers: EngineWorker[] = [];

const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-requests-"));
  roots.push(directory);
  return directory;
};

afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.stop();
  for (const daemon of daemons.splice(0)) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function eventually(assertion: () => void | Promise<void>, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
  throw last;
}

function readyStore(runtimeMode: "approval-required" | "auto" | "full-access" | "auto-accept-edits"): {
  store: EngineStore;
  parked: string[];
} {
  const parked: string[] = [];
  const store = new EngineStore(root(), () => 100, {
    notifier: ({ requestId }) => {
      parked.push(requestId);
      return true;
    },
  });
  store.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  store.createSession({ id: "session_one", projectId: "project_one" });
  // Runtime mode is chosen at creation from `detached`; set it directly here
  // so each case tests one mode rather than the default ladder.
  const file = path.join(store.paths.sessions, "session_one", "session.json");
  const session = JSON.parse(fs.readFileSync(file, "utf8")) as { runtimeMode: string };
  session.runtimeMode = runtimeMode;
  fs.writeFileSync(file, JSON.stringify(session));
  return { store, parked };
}

function runningTurn(store: EngineStore): string {
  store.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  const claimed = store.claimTurn("session_one", "worker_one")!;
  store.markRunning("session_one", "run_one", claimed.claim!.token);
  return claimed.claim!.token;
}

const bashDetail = { kind: "command_execution" as const, command: { command: "rm -rf build" } };

test("full-access resolves by policy with no human and nobody notified", () => {
  const { store, parked } = readyStore("full-access");
  const token = runningTurn(store);
  const opened = store.openRequest("session_one", "run_one", token, {
    requestId: "req_1",
    kind: "command_execution",
    detail: bashDetail,
  });
  expect(opened).toMatchObject({ state: "resolved", decision: "accept", resolvedBy: "policy" });
  // Nothing parked, so nothing to notify about.
  expect(parked).toEqual([]);
  const types = store.readEvents("session_one").map((event) => event.type);
  expect(types.filter((type) => type.startsWith("request."))).toEqual(["request.opened", "request.resolved"]);
});

test("approval-required parks a command, records that someone was told, and blocks the queue", () => {
  const { store, parked } = readyStore("approval-required");
  const token = runningTurn(store);
  const opened = store.openRequest("session_one", "run_one", token, {
    requestId: "req_1",
    kind: "command_execution",
    detail: bashDetail,
  });
  expect(opened).toMatchObject({ state: "open", notified: true });
  expect(parked).toEqual(["req_1"]);
  expect(store.requests("session_one")[0]).toMatchObject({ state: "open", notified: true });
});

test("with NO notifier a parked request records notified:false rather than implying someone was told", () => {
  // "Stuck and nobody was told" has to be a detectable state, not an inference
  // from absence. This is the assertion that keeps `notified` honest.
  const store = new EngineStore(root(), () => 100);
  store.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  store.createSession({ id: "session_one", projectId: "project_one", detached: false });
  const token = runningTurn(store);
  const opened = store.openRequest("session_one", "run_one", token, {
    requestId: "req_1",
    kind: "command_execution",
    detail: bashDetail,
  });
  expect(opened).toMatchObject({ state: "open", notified: false });
});

test("auto-accept-edits passes a file change and still parks a command", () => {
  const { store } = readyStore("auto-accept-edits");
  const token = runningTurn(store);
  expect(
    store.openRequest("session_one", "run_one", token, {
      requestId: "req_edit",
      kind: "file_change",
      detail: { kind: "file_change", change: { path: "src/a.ts", kind: "edit" } },
    }),
  ).toMatchObject({ state: "resolved", decision: "accept" });
  expect(
    store.openRequest("session_one", "run_one", token, {
      requestId: "req_cmd",
      kind: "command_execution",
      detail: bashDetail,
    }),
  ).toMatchObject({ state: "open" });
});

test("a human answer resolves the request once and only once", () => {
  const { store } = readyStore("approval-required");
  const token = runningTurn(store);
  store.openRequest("session_one", "run_one", token, { requestId: "req_1", kind: "command_execution", detail: bashDetail });

  const resolved = store.resolveRequest("session_one", "req_1", { decision: "decline", reason: "too broad" });
  expect(resolved).toMatchObject({ state: "resolved", decision: "decline", resolvedBy: "human", reason: "too broad" });
  // A second answer is a conflict, not a silent overwrite: the provider has
  // already been told, and changing the record would make the journal lie.
  expect(() => store.resolveRequest("session_one", "req_1", { decision: "accept" })).toThrow(EngineStateError);
});

test("opening the same requestId twice returns the SAME answer instead of a second request", () => {
  // A worker that retries after a dropped response must not open a second
  // request — the provider is blocked on the first one.
  const { store } = readyStore("approval-required");
  const token = runningTurn(store);
  const first = store.openRequest("session_one", "run_one", token, { requestId: "req_1", kind: "command_execution", detail: bashDetail });
  const second = store.openRequest("session_one", "run_one", token, { requestId: "req_1", kind: "command_execution", detail: bashDetail });
  expect(second).toEqual(first);
  expect(store.requests("session_one")).toHaveLength(1);

  store.resolveRequest("session_one", "req_1", { decision: "accept" });
  expect(store.openRequest("session_one", "run_one", token, { requestId: "req_1", kind: "command_execution", detail: bashDetail })).toMatchObject({
    state: "resolved",
    decision: "accept",
  });
});

test("a resolution is offered to the worker that holds the running claim, and not to others", () => {
  const { store } = readyStore("approval-required");
  const token = runningTurn(store);
  store.openRequest("session_one", "run_one", token, { requestId: "req_1", kind: "command_execution", detail: bashDetail });
  expect(store.resolutionsForWorker("worker_one")).toEqual([]);

  store.resolveRequest("session_one", "req_1", { decision: "accept" });
  expect(store.resolutionsForWorker("worker_one")).toEqual([
    { requestId: "req_1", sessionId: "session_one", runId: "run_one", decision: "accept" },
  ]);
  expect(store.resolutionsForWorker("worker_two")).toEqual([]);
});

test("a driver blocked on a human is unblocked by the heartbeat, end to end", async () => {
  const daemon = await startEngine({ engineRoot: root(), workerLeaseMs: 2_000, notifier: () => true });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  // Attended → approval-required, so the command genuinely parks.
  await client.createSession({ id: "session_one", projectId: "project_one", detached: false });

  let decided: string | undefined;
  const driver: TurnDriver = {
    async run({ onRequest }) {
      // The worker answers with an OUTCOME ({decision, answers?}) — the shape
      // user_input needs; approval-shaped callers read `.decision`.
      decided = normalizeOutcome(
        await onRequest!({
          kind: "command_execution",
          detail: bashDetail,
          toolUseId: "toolu_1",
        }),
      ).decision;
      return { text: `decided:${decided}` };
    },
  };
  const worker = new EngineWorker({ client, workerId: "worker_one", driver, pollMs: 25 });
  workers.push(worker);
  await worker.start();
  await client.submitTurn("session_one", { runId: "run_one", input: "Hello" });

  // The request parks and the turn stays running while a human thinks.
  await eventually(async () => {
    const open = (await client.session("session_one")).requests.filter((request) => request.state === "open");
    expect(open).toHaveLength(1);
  });
  const parked = (await client.session("session_one")).requests[0]!;
  expect((await client.session("session_one")).turns[0]?.state).toBe("running");

  await client.resolveRequest("session_one", parked.id, { decision: "accept" });
  await eventually(async () => {
    expect((await client.session("session_one")).turns[0]).toMatchObject({ state: "completed", resultText: "decided:accept" });
  });
  expect(decided).toBe("accept");
});

test("a stop while a human is deciding settles the driver instead of hanging the turn forever", async () => {
  // THE DEADLOCK THIS PREVENTS: canUseTool has no park deadline, so a worker
  // blocked on an answer that never comes would keep the turn running for the
  // life of the process.
  const daemon = await startEngine({ engineRoot: root(), workerLeaseMs: 2_000 });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  await client.createSession({ id: "session_one", projectId: "project_one", detached: false });

  let seen: string | undefined;
  const driver: TurnDriver = {
    async run({ onRequest }) {
      seen = normalizeOutcome(await onRequest!({ kind: "command_execution", detail: bashDetail, toolUseId: "toolu_1" })).decision;
      return { text: "unreachable" };
    },
  };
  const worker = new EngineWorker({ client, workerId: "worker_one", driver, pollMs: 25 });
  workers.push(worker);
  await worker.start();
  await client.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  await eventually(async () => {
    expect((await client.session("session_one")).requests).toHaveLength(1);
  });

  await client.stopTurn("session_one", "run_one");
  await eventually(() => expect(seen).toBe("cancel"));
  expect((await client.session("session_one")).turns[0]?.state).toBe("stopped");
});
