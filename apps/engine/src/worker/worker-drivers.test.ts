import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient } from "@telar/engine-client";
import { startEngine } from "../daemon";
import { ProviderUnavailableError, type TurnDriver } from "../drivers";
import { defaultWorkerConcurrency, EngineWorker } from ".";
import { stubModels } from "../../test/stub-models";
import { eventually } from "../../test/wait";
import { daemons, root, setup, teardown, workers } from "../../test/worker-daemon";

afterEach(teardown);

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
  // The cwd is the canonicalized project root: /tmp is /private/tmp on macOS only.
  expect(calls).toEqual([`Hello:${fs.realpathSync.native("/tmp")}`]);
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

test("a turn's effort, fast mode, service tier and ultracode reach the driver from the claim", async () => {
  const seen: Record<string, unknown>[] = [];
  const driver: TurnDriver = {
    async run({ model, effort, fastMode, serviceTier, ultracode }) {
      seen.push({ model, effort, fastMode, serviceTier, ultracode });
      return { text: "done" };
    },
  };
  const { client, sessionId, worker } = await setup(driver);
  await client.submitTurn(sessionId, {
    runId: "run_one",
    input: "Hello",
    model: { model: "claude-opus-5[1m]", effort: "xhigh", fastMode: true, serviceTier: "priority", ultracode: true },
  });
  await worker.tick();
  await eventually(async () => expect(seen).toHaveLength(1));
  expect(seen[0]).toEqual({ model: "claude-opus-5[1m]", effort: "xhigh", fastMode: true, serviceTier: "priority", ultracode: true });
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
  const daemon = await startEngine({ models: stubModels, engineRoot: root(), workerLeaseMs: 60_000 });
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
  const daemon = await startEngine({ models: stubModels, engineRoot: root(), workerLeaseMs: 60_000 });
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

test("turns from DIFFERENT sessions run concurrently up to the cap; one session stays serial", async () => {
  const running = new Set<string>();
  let peak = 0;
  const gate: { release?: () => void } = {};
  const released = new Promise<void>((resolve) => {
    gate.release = resolve;
  });
  const driver: TurnDriver = {
    async run({ prompt }) {
      running.add(prompt);
      peak = Math.max(peak, running.size);
      await released;
      running.delete(prompt);
      return { text: `done ${prompt}` };
    },
  };
  const daemon = await startEngine({ models: stubModels, engineRoot: root(), workerLeaseMs: 60_000 });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  const project = await client.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  await client.createSession({ id: "session_a", projectId: project.project.id });
  await client.createSession({ id: "session_b", projectId: project.project.id });
  const worker = new EngineWorker({ client, workerId: "worker_one", driver, concurrency: 2, pollMs: 60_000 });
  workers.push(worker);
  await worker.start();

  await client.submitTurn("session_a", { runId: "a1", input: "A1" });
  await client.submitTurn("session_a", { runId: "a2", input: "A2" });
  await client.submitTurn("session_b", { runId: "b1", input: "B1" });
  await worker.tick();
  // Both SESSIONS progress together; session_a's second turn must NOT start
  // while its first is running — that exclusion is the engine's, and it holds.
  await eventually(() => expect([...running].sort()).toEqual(["A1", "B1"]));
  expect(peak).toBe(2);
  gate.release!();
  await eventually(async () => expect((await client.session("session_a")).turns[0]?.state).toBe("completed"));
  await worker.tick();
  await eventually(async () => expect((await client.session("session_a")).turns[1]?.state).toBe("completed"));
});

test("a project folder that no longer exists fails the turn with the folder named — never a spawn", async () => {
  const { assertProjectRoot } = await import(".");
  expect(() => assertProjectRoot("/definitely/not/here/telar-integration")).toThrow(/does not exist.*moved or deleted.*re-register/i);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "telar-root-")), "file.txt");
  fs.writeFileSync(file, "x");
  expect(() => assertProjectRoot(file)).toThrow(/not a folder/);
  expect(() => assertProjectRoot(os.tmpdir())).not.toThrow();
  // Through the worker: the driver is never invoked; the turn fails with the sentence.
  let invoked = 0;
  const driver: TurnDriver = { run: async () => { invoked += 1; return { text: "" }; } };
  const daemon = await startEngine({ models: stubModels, engineRoot: root(), workerLeaseMs: 60_000 });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  const stale = fs.mkdtempSync(path.join(os.tmpdir(), "telar-stale-"));
  const project = await client.registerProject({ id: "project_stale", name: "Stale", root: stale });
  const session = await client.createSession({ id: "session_stale", projectId: project.project.id });
  fs.rmSync(stale, { recursive: true, force: true });
  const worker = new EngineWorker({ client, workerId: "worker_stale", driver, pollMs: 60_000 });
  workers.push(worker);
  await worker.start();
  await client.submitTurn(session.session.id, { runId: "run_stale", input: "Hello" });
  await worker.tick();
  await eventually(async () => expect((await client.session(session.session.id)).turns[0]).toMatchObject({ state: "failed" }));
  const failed = (await client.events(session.session.id)).events.find((event) => event.type === "turn.failed");
  expect(failed && failed.type === "turn.failed" ? failed.message : "").toMatch(/project folder .* does not exist/);
  expect(invoked).toBe(0);
});

test("the default concurrency is derived from memory, with a floor and a ceiling", () => {
  // A small machine keeps the old behaviour...
  expect(defaultWorkerConcurrency(4 * 1024 ** 3)).toBe(4);
  expect(defaultWorkerConcurrency(8 * 1024 ** 3)).toBe(8);
  // ...a large one is allowed to use what it has, up to where the daemon's own
  // single event loop — not memory — becomes the limit.
  expect(defaultWorkerConcurrency(24 * 1024 ** 3)).toBe(24);
  expect(defaultWorkerConcurrency(256 * 1024 ** 3)).toBe(24);
});

test("a turn the PROVIDER opened does not hold an execution slot shut", async () => {
  // A provider-opened turn was never scheduled through the gate, so it holds no slot.
  const release: Array<() => void> = [];
  const started: string[] = [];
  let openProviderTurn: (() => Promise<void>) | undefined;

  const driver: TurnDriver = {
    async run({ prompt, session }) {
      started.push(prompt);
      if (prompt === "A1" && session) {
        // The provider process OUTLIVES its turn, which is how a background
        // task can wake it later. That later wake-up is what this captures.
        openProviderTurn = async () => {
          await session.onProviderTurn({ input: "woken", reason: { kind: "task_notification" } });
        };
        return { text: "done A1" };
      }
      // Session B parks, so the claim it takes is observable.
      await new Promise<void>((resolve) => release.push(resolve));
      return { text: `done ${prompt}` };
    },
  };

  const daemon = await startEngine({ models: stubModels, engineRoot: root(), workerLeaseMs: 60_000 });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  const project = await client.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  for (const id of ["session_a", "session_b"]) await client.createSession({ id, projectId: project.project.id });
  // ONE slot, so a wake-up wrongly holding it is the difference between B
  // running and B sitting at "queued" forever.
  const worker = new EngineWorker({ client, workerId: "worker_one", driver, concurrency: 1, pollMs: 60_000 });
  workers.push(worker);
  await worker.start();

  await client.submitTurn("session_a", { runId: "a1", input: "A1" });
  await worker.tick();
  await eventually(async () => expect((await client.session("session_a")).turns[0]?.state).toBe("completed"));

  // A background task wakes session_a BETWEEN turns: a real, live, running
  // turn that no worker ever claimed — and that is left open here.
  await openProviderTurn!();
  await eventually(async () => expect((await client.session("session_a")).turns[1]?.state).toBe("running"));

  await client.submitTurn("session_b", { runId: "b1", input: "B1" });
  await worker.tick();
  // The one slot was never the wake-up's to hold.
  await eventually(() => expect(started).toEqual(["A1", "B1"]));

  for (const resolve of release.splice(0)) resolve();
});
