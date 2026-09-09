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

test("a stalled daemon preserves its embedded worker and all active turns past the lease", async () => {
  let time = 0;
  let disposed = 0;
  let drivers = 0;
  const releases: Array<() => void> = [];
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
        return {
          run: async ({ prompt }) => {
            await new Promise<void>((resolve) => releases.push(resolve));
            return { text: prompt };
          },
          dispose: () => void (disposed += 1),
        };
      },
    },
  });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  for (const n of [1, 2, 3]) {
    await client.createSession({ id: `session_${n}`, projectId: "project_one" });
    await client.submitTurn(`session_${n}`, { runId: `run_${n}`, input: `work ${n}` });
  }
  await eventually(() => expect(releases).toHaveLength(3));

  // Both timers resume after a shared event-loop stall. The pruner must not
  // interpret the daemon's own missed beats as the death of all three agents.
  time = 5_000;
  await client.health();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect((await client.health()).worker).toMatchObject({ registered: true, workerId: "worker_embedded_first" });
  expect(drivers).toBe(1);
  expect(disposed).toBe(0);
  for (const n of [1, 2, 3]) {
    expect((await client.session(`session_${n}`)).turns[0]?.state).toBe("running");
  }
  for (const release of releases) release();
  await eventually(async () => {
    for (const n of [1, 2, 3]) {
      expect((await client.session(`session_${n}`)).turns[0]).toMatchObject({ state: "completed", resultText: `work ${n}` });
    }
  });
  await daemon.close();
  expect(disposed).toBe(1);
});

test("an external worker with an embedded-looking id still expires", async () => {
  let time = 0;
  const daemon = await startEngine({
    engineRoot: root(), now: () => time, workerLeaseMs: 1_000,
    workerPruneIntervalMs: 5,
    embeddedWorker: { createDriver: () => echo, pollMs: 20 },
  });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  await client.registerWorker("worker_embedded_spoof");
  await expect(client.registerWorker(daemon.worker!.workerId)).rejects.toMatchObject({ code: "conflict" });
  time = 5_000;
  await expect(client.workerHeartbeat("worker_embedded_spoof")).rejects.toMatchObject({ code: "worker_unavailable" });
  expect((await client.health()).worker).toMatchObject({ registered: true, workerId: daemon.worker!.workerId });
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

/**
 * A provider that says who it is, streams a little, opens a tool row, and then
 * never finishes on its own — the shape of a real turn caught mid-work.
 */
const workingForever: TurnDriver = {
  run: async ({ onObservations, signal }) => {
    await onObservations?.([
      { kind: "provider.session", providerSessionId: "provider-thread-xyz" },
      { kind: "item.started", item: { id: "msg_1", detail: { type: "assistant_message", text: "Working on it…" } } },
      { kind: "item.completed", itemId: "msg_1", status: "completed" },
      { kind: "item.started", item: { id: "tool_1", detail: { type: "command_execution", command: { command: "bun test" } } } },
    ]);
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    return { text: "" };
  },
};

test("quitting mid-turn records the interruption, and the next boot offers an ordinary continuation", async () => {
  /**
   * THE BUG THIS PINS, END TO END. Before it: a clean quit left the turn
   * `running` on disk, the next boot called it `ambiguous`, and the session
   * then refused every new message — so the only way forward was the recovery
   * card's replay of the original prompt.
   *
   * The provider here is a FAKE. What is proven is Telar's own bookkeeping —
   * turn states, transcript, resume cursor, what the next boot will accept.
   * Whether a real Claude or Codex conversation can still see the partial turn
   * after its process was killed is a PROVIDER question this does not touch.
   */
  const stateRoot = root();
  const first = await startEngine({
    engineRoot: stateRoot,
    workerLeaseMs: 5_000,
    embeddedWorker: { createDriver: () => workingForever, pollMs: 25 },
  });
  const client = new EngineClient(first.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  await client.createSession({ id: "session_one", projectId: "project_one" });
  await client.submitTurn("session_one", { runId: "run_one", input: "Refactor the parser and run the tests" });
  await eventually(async () => {
    const live = await client.session("session_one");
    expect(live.turns[0]?.state).toBe("running");
    expect(live.items.length).toBeGreaterThan(0);
  });

  // The human quits Telar. This is the exact call the desktop's `will-quit`
  // SIGTERM reaches, and the settle has to land before the server closes.
  await first.close();

  const second = await startEngine({
    engineRoot: stateRoot,
    workerLeaseMs: 5_000,
    embeddedWorker: { createDriver: () => workingForever, pollMs: 25 },
  });
  daemons.push(second);
  const client2 = new EngineClient(second.discovery);
  const recovered = await client2.session("session_one");

  // Honest about what happened, and terminal — NOT ambiguous.
  expect(recovered.turns[0]).toMatchObject({ runId: "run_one", state: "stopped" });
  // Everything it streamed is kept; the open tool row is closed as failed.
  expect(recovered.items.map((item) => [item.id, item.status])).toEqual([
    ["msg_1", "completed"],
    ["tool_1", "failed"],
  ]);
  // And the conversation is still reachable.
  expect(recovered.session.resumeCursor).toBe("provider-thread-xyz");

  // THE POINT: an ordinary next message, with no decision to make and no
  // replay of the original prompt.
  const next = await client2.submitTurn("session_one", { runId: "run_two", input: "Just tell me what you found." });
  expect(next.turn.state).toBe("queued");
});

test("a real event-loop stall preserves the embedded generation and streamed snapshot", async () => {
  let finish!: () => void;
  let aborted = false;
  let runs = 0;
  const daemon = await startEngine({
    engineRoot: root(),
    workerLeaseMs: 150,
    embeddedWorker: { pollMs: 10, createDriver: () => ({
      run: async ({ onObservations, signal }) => {
        runs += 1;
        signal.addEventListener("abort", () => { aborted = true; finish?.(); }, { once: true });
        await onObservations?.([
          { kind: "item.started", item: { id: "partial", detail: { type: "assistant_message", text: "" } } },
          { kind: "content.delta", itemId: "partial", stream: "assistant_text", text: "Preserve this prefix" },
        ]);
        await new Promise<void>((resolve) => { finish = resolve; });
        return { text: "Preserve this prefix" };
      },
    }) },
  });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  await client.createSession({ id: "session_one", projectId: "project_one" });
  await client.submitTurn("session_one", { runId: "run_one", input: "hello" });
  await eventually(async () => expect((await client.session("session_one")).items.find(i => i.id === "partial")?.streamed).toBe("Preserve this prefix"));
  const generation = daemon.worker!.workerId;
  // Suspend BOTH timer loops, not just the daemon's injected clock.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);
  await new Promise(resolve => setTimeout(resolve, 80));
  expect(daemon.worker!.workerId).toBe(generation);
  expect(aborted).toBe(false);
  expect(runs).toBe(1);
  daemon.store.forgetOpenPrefixesForTest();
  const remounted = await client.session("session_one");
  expect(remounted.turns[0]?.state).toBe("running");
  expect(remounted.items.find(i => i.id === "partial")?.streamed).toBe("Preserve this prefix");
  finish();
  await eventually(async () => expect((await client.session("session_one")).turns[0]?.state).toBe("completed"));
});
