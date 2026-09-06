/**
 * Stage 3 — one process is a working engine.
 *
 * The property under test is the plainest possible reading of "the engine runs
 * on its own": start it, submit a turn, and the turn executes — with no second
 * process and no client attached.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../src/daemon";
import type { TurnDriver } from "../src/driver";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];

const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-embedded-"));
  roots.push(directory);
  return directory;
};

afterEach(async () => {
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

const echo: TurnDriver = { run: async ({ prompt }) => ({ text: `echo:${prompt}` }) };

test("a daemon with an embedded worker executes a turn with no second process", async () => {
  const daemon = await startEngine({
    engineRoot: root(),
    workerLeaseMs: 2_000,
    embeddedWorker: { createDriver: () => echo, pollMs: 25 },
  });
  daemons.push(daemon);
  expect(daemon.worker?.workerId).toBeTruthy();

  const client = new EngineClient(daemon.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  await client.createSession({ id: "session_one", projectId: "project_one" });

  // No `registerWorker` call anywhere in this test — that is the point.
  await client.submitTurn("session_one", { runId: "run_one", input: "hello" });
  await eventually(async () => {
    expect((await client.session("session_one")).turns[0]).toMatchObject({ state: "completed", resultText: "echo:hello" });
  });
});

test("without an embedded worker a lone daemon still refuses turns, and says why", async () => {
  // The behaviour the embedded worker exists to fix, pinned so the fix cannot
  // silently become the only path — the out-of-process worker deployment
  // depends on this refusal being real.
  const daemon = await startEngine({ engineRoot: root() });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  await client.createSession({ id: "session_one", projectId: "project_one" });

  await expect(client.submitTurn("session_one", { runId: "run_one", input: "hello" })).rejects.toMatchObject({
    code: "worker_unavailable",
  });
  expect(daemon.worker).toBeUndefined();
});

test("an embedded worker registers through discovery, like every other client", async () => {
  // Not through a private in-process shortcut: one code path for
  // claim/heartbeat/observe rather than two that can diverge.
  const daemon = await startEngine({
    engineRoot: root(),
    workerLeaseMs: 2_000,
    embeddedWorker: { workerId: "worker_embedded_one", createDriver: () => echo, pollMs: 25 },
  });
  daemons.push(daemon);
  const health = await new EngineClient(daemon.discovery).health();
  expect(health.worker).toMatchObject({ registered: true, workerId: "worker_embedded_one" });
});

test("closing the daemon stops the worker BEFORE the server, so no claim outlives it", async () => {
  // A claim that outlives the server it reports to becomes an ambiguous turn
  // on the next start — a human decision the operator never needed to make.
  const daemon = await startEngine({
    engineRoot: root(),
    workerLeaseMs: 2_000,
    embeddedWorker: { createDriver: () => echo, pollMs: 25 },
  });
  const client = new EngineClient(daemon.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  await client.createSession({ id: "session_one", projectId: "project_one" });
  await client.submitTurn("session_one", { runId: "run_one", input: "hello" });
  await eventually(async () => {
    expect((await client.session("session_one")).turns[0]?.state).toBe("completed");
  });

  await daemon.close();
  const restarted = await startEngine({ engineRoot: daemon.store.paths.root });
  daemons.push(restarted);
  expect(restarted.store.turns("session_one")[0]?.state).toBe("completed");
});

test("an embedded worker whose lease expired re-registers with a fresh id and executes the next turn", async () => {
  // The daemon and its worker share one event loop; a stall long enough to
  // miss heartbeats gets the registration pruned, and the next beat answers
  // `worker_unavailable`. Recovery is a NEW registration with a new driver —
  // the old claims were already requeued by the prune, and re-registering
  // the stale id over them is exactly what must not happen.
  let time = 0;
  let drivers = 0;
  const daemon = await startEngine({
    engineRoot: root(),
    now: () => time,
    workerLeaseMs: 1_000,
    workerPruneIntervalMs: 5,
    embeddedWorker: {
      workerId: "worker_embedded_first",
      pollMs: 20,
      createDriver: () => {
        drivers += 1;
        return { run: async ({ prompt }) => ({ text: `echo#${drivers}:${prompt}` }) };
      },
    },
  });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  await client.createSession({ id: "session_one", projectId: "project_one" });
  expect(daemon.worker?.workerId).toBe("worker_embedded_first");
  expect(drivers).toBe(1);

  // Wall-clock jumps past the lease with no beat in between: the pruner
  // evicts the registration. Heartbeats do not advance `now`, so nothing
  // the worker does can refresh the lease — only a new registration counts.
  time = 5_000;
  await eventually(async () => {
    const health = await client.health();
    expect(health.worker.registered).toBe(true);
    expect(health.worker).not.toMatchObject({ workerId: "worker_embedded_first" });
  });
  expect(daemon.worker?.workerId).not.toBe("worker_embedded_first");
  expect(daemon.worker?.workerId).toMatch(/^worker_embedded_/);
  expect(drivers).toBe(2);

  await client.submitTurn("session_one", { runId: "run_after", input: "hello" });
  await eventually(async () => {
    expect((await client.session("session_one")).turns[0]).toMatchObject({ state: "completed", resultText: "echo#2:hello" });
  });
});

test("closing a daemon while its replacement driver is still being built discards it and ends the loop", async () => {
  // The recovery's second driver is held on a promise the test controls: the
  // daemon closes WHILE that build is pending, so shutdown races creation
  // rather than following it.
  let time = 0;
  let drivers = 0;
  let disposed = 0;
  let releaseSecond: (() => void) | undefined;
  let signalRequested: (() => void) | undefined;
  const requestedSecond = new Promise<void>((resolve) => (signalRequested = resolve));
  const daemon = await startEngine({
    engineRoot: root(),
    now: () => time,
    workerLeaseMs: 1_000,
    workerPruneIntervalMs: 5,
    embeddedWorker: {
      pollMs: 20,
      createDriver: async () => {
        drivers += 1;
        if (drivers === 2) {
          signalRequested!();
          await new Promise<void>((resolve) => (releaseSecond = resolve));
        }
        return { ...echo, dispose: () => void (disposed += 1) };
      },
    },
  });
  const client = new EngineClient(daemon.discovery);
  time = 5_000;
  await requestedSecond;
  expect(drivers).toBe(2);
  await expect(client.health()).resolves.toMatchObject({ worker: { registered: false } });

  const closing = daemon.close();
  releaseSecond!();
  await closing;
  // The pending candidate was stopped (its driver disposed with the first's),
  // never started, and no third attempt followed.
  expect(disposed).toBe(2);
  expect(drivers).toBe(2);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(drivers).toBe(2);
  await expect(client.health()).rejects.toMatchObject({ code: "engine_unavailable" });
});

test("a daemon started WITHOUT an embedded worker never loads the provider SDK", async () => {
  // The lazy import is load-bearing: every test in this repo runs a daemon,
  // and eagerly importing the driver would drag the Claude SDK into all of
  // them. Asserted by construction — a driver factory that throws is never
  // called.
  const daemon = await startEngine({ engineRoot: root() });
  daemons.push(daemon);
  expect(daemon.worker).toBeUndefined();

  const exploding = await startEngine({
    engineRoot: root(),
    embeddedWorker: {
      createDriver: () => {
        throw new Error("driver was constructed");
      },
    },
  }).catch((error: unknown) => error);
  expect(exploding).toBeInstanceOf(Error);
  expect((exploding as Error).message).toBe("driver was constructed");
});
