import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../src/daemon";
import { ProviderUnavailableError, type TurnDriver } from "../src/driver";
import { EngineWorker } from "../src/worker";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];
const workers: EngineWorker[] = [];

const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-vnext-worker-"));
  roots.push(directory);
  return directory;
};

afterEach(async () => {
  for (const worker of workers.splice(0).reverse()) await worker.stop();
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function eventually(check: () => void | Promise<void>): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await check();
      return;
    } catch (error) {
      last = error;
      await Bun.sleep(5);
    }
  }
  throw last;
}

async function setup(driver: TurnDriver): Promise<{ client: EngineClient; sessionId: string; worker: EngineWorker }> {
  const daemon = await startEngine({ vnextRoot: root(), workerLeaseMs: 1_000 });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  const project = await client.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  const session = await client.createSession({ id: "session_one", projectId: project.project.id });
  const worker = new EngineWorker({ client, workerId: "worker_one", driver, pollMs: 60_000 });
  workers.push(worker);
  await worker.start();
  return { client, sessionId: session.session.id, worker };
}

test("a fake driver streams engine-owned text and completes a scheduled turn", async () => {
  const calls: string[] = [];
  const driver: TurnDriver = {
    async run({ prompt, cwd, onObservations }) {
      calls.push(`${prompt}:${cwd}`);
      await onObservations([
        { kind: "item.started", item: { id: "i1", detail: { type: "assistant_message", text: "" } } },
        { kind: "content.delta", itemId: "i1", stream: "assistant_text", text: "partial response" },
        { kind: "item.completed", itemId: "i1", status: "completed" },
      ]);
      return { text: "final response" };
    },
  };
  const { client, sessionId, worker } = await setup(driver);
  await client.submitTurn(sessionId, { runId: "run_one", input: "Hello" });
  await worker.tick();
  await eventually(async () => expect((await client.session(sessionId)).turns[0]).toMatchObject({ state: "completed", resultText: "final response" }));
  expect(calls).toEqual(["Hello:/private/tmp"]);
  expect((await client.events(sessionId)).events.map((event) => event.type)).toEqual([
    "session.created",
    "turn.accepted",
    "turn.claimed",
    "turn.started",
    "item.started",
    "content.delta",
    "item.completed",
    "turn.completed",
  ]);
});

test("a whitespace-only provider delta is a valid stream observation, not an invalid user prompt", async () => {
  const driver: TurnDriver = {
    async run({ onObservations }) {
      await onObservations([
        { kind: "item.started", item: { id: "i1", detail: { type: "assistant_message", text: "" } } },
        { kind: "content.delta", itemId: "i1", stream: "assistant_text", text: " " },
        { kind: "content.delta", itemId: "i1", stream: "assistant_text", text: "done" },
      ]);
      return { text: " done" };
    },
  };
  const { client, sessionId, worker } = await setup(driver);
  await client.submitTurn(sessionId, { runId: "run_one", input: "Hello" });
  await worker.tick();
  await eventually(async () => expect((await client.session(sessionId)).turns[0]).toMatchObject({ state: "completed", resultText: " done" }));
  expect(
    (await client.events(sessionId)).events
      .filter((event) => event.type === "content.delta")
      .map((event) => (event.type === "content.delta" ? event.text : "")),
  ).toEqual([" ", "done"]);
});

test("stop reaches the active fake driver and remains the durable terminal state", async () => {
  let sawAbort = false;
  const driver: TurnDriver = {
    async run({ onObservations, signal }) {
      await onObservations([
        { kind: "item.started", item: { id: "i1", detail: { type: "assistant_message", text: "" } } },
      ]);
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            sawAbort = true;
            reject(signal.reason);
          },
          { once: true },
        );
      });
      return { text: "unreachable" };
    },
  };
  const { client, sessionId, worker } = await setup(driver);
  await client.submitTurn(sessionId, { runId: "run_one", input: "Stop me" });
  await worker.tick();
  await eventually(async () => expect((await client.session(sessionId)).turns[0]?.state).toBe("running"));
  await client.stopTurn(sessionId, "run_one");
  await worker.tick();
  await eventually(() => expect(sawAbort).toBe(true));
  expect((await client.session(sessionId)).turns[0]).toMatchObject({ state: "stopped" });
  expect((await client.events(sessionId)).events.at(-1)).toMatchObject({ type: "turn.stopped", runId: "run_one" });
});

test("an unavailable provider becomes a typed durable failure instead of a success", async () => {
  const driver: TurnDriver = { run: async () => Promise.reject(new ProviderUnavailableError("Claude is not configured")) };
  const { client, sessionId, worker } = await setup(driver);
  await client.submitTurn(sessionId, { runId: "run_one", input: "Hello" });
  await worker.tick();
  await eventually(async () =>
    expect((await client.session(sessionId)).turns[0]).toMatchObject({
      state: "failed",
      failure: { code: "provider_unavailable", message: "Claude is not configured" },
    }),
  );
  expect((await client.events(sessionId)).events.at(-1)).toMatchObject({ type: "turn.failed", runId: "run_one", code: "provider_unavailable" });
});

test("the worker routes each turn to the driver its SESSION named", async () => {
  const ran: string[] = [];
  const named = (label: string): TurnDriver => ({
    run: async () => {
      ran.push(label);
      return { text: label };
    },
  });
  const daemon = await startEngine({ vnextRoot: root(), workerLeaseMs: 1_000 });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  await client.createSession({ id: "session_claude", projectId: "project_one" });
  await client.createSession({ id: "session_codex", projectId: "project_one", driver: "codex" });
  const worker = new EngineWorker({
    client,
    workerId: "worker_one",
    driver: (kind) => (kind === "codex" ? named("codex") : named("claude")),
    pollMs: 60_000,
  });
  workers.push(worker);
  await worker.start();

  // A worker holding ONE driver would run this through the Claude SDK and
  // produce a plausible, wrong transcript.
  await client.submitTurn("session_codex", { runId: "run_one", input: "Hello" });
  await worker.tick();
  await eventually(async () => expect((await client.session("session_codex")).turns[0]?.state).toBe("completed"));
  await client.submitTurn("session_claude", { runId: "run_two", input: "Hello" });
  await worker.tick();
  await eventually(async () => expect((await client.session("session_claude")).turns[0]?.state).toBe("completed"));
  expect(ran).toEqual(["codex", "claude"]);
});

test("a session whose provider this worker cannot serve fails the turn instead of hanging", async () => {
  const daemon = await startEngine({ vnextRoot: root(), workerLeaseMs: 1_000 });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  await client.createSession({ id: "session_codex", projectId: "project_one", driver: "codex" });
  const worker = new EngineWorker({
    client,
    workerId: "worker_one",
    driver: (kind) => (kind === "claude" ? { run: async () => ({ text: "" }) } : undefined),
    pollMs: 60_000,
  });
  workers.push(worker);
  await worker.start();
  await client.submitTurn("session_codex", { runId: "run_one", input: "Hello" });
  await worker.tick();
  // Resolved inside the settle path, so the turn ends with a reason rather than
  // sitting claimed until the lease expires.
  await eventually(async () =>
    expect((await client.session("session_codex")).turns[0]).toMatchObject({
      state: "failed",
      failure: { code: "provider_unavailable" },
    }),
  );
});

test("engine connectivity loss aborts active provider execution", async () => {
  let sawAbort = false;
  const driver: TurnDriver = {
    async run({ signal }) {
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => {
        sawAbort = true;
        reject(signal.reason);
      }, { once: true }));
      return { text: "unreachable" };
    },
  };
  const { client, sessionId, worker } = await setup(driver);
  await client.submitTurn(sessionId, { runId: "run_one", input: "Hello" });
  await worker.tick();
  await eventually(async () => expect((await client.session(sessionId)).turns[0]?.state).toBe("running"));
  await daemons.at(-1)!.close();
  await worker.tick();
  await eventually(() => expect(sawAbort).toBe(true));
});

test("a completed Claude session id is persisted and used for the next claimed turn", async () => {
  const seen: Array<string | undefined> = [];
  const driver: TurnDriver = {
    async run({ providerSessionId }) {
      seen.push(providerSessionId);
      return { text: "done", providerSessionId: "claude-session-one" };
    },
  };
  const { client, sessionId, worker } = await setup(driver);
  await client.submitTurn(sessionId, { runId: "first", input: "One" });
  await worker.tick();
  await eventually(async () => expect((await client.session(sessionId)).turns[0]?.state).toBe("completed"));
  const first = await client.session(sessionId);
  expect(first.session.resumeCursor).toBe("claude-session-one");
  expect(first.session.driver).toBe("claude");
  expect(first.turns[0]).toMatchObject({ providerSessionId: "claude-session-one" });
  await client.submitTurn(sessionId, { runId: "second", input: "Two" });
  await worker.tick();
  await eventually(async () => expect((await client.session(sessionId)).turns[1]?.state).toBe("completed"));
  expect(seen).toEqual([undefined, "claude-session-one"]);
});
