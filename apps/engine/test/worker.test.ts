import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient } from "@telar/engine-client";
import { BrowserToolSocket } from "../src/browser/socket";
import { startEngine, type EngineDaemon } from "../src/daemon";
import { ProviderUnavailableError, type TurnDriver } from "../src/driver";
import { EngineWorker } from "../src/worker";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];
const workers: EngineWorker[] = [];

const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-worker-"));
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

async function setup(
  driver: TurnDriver,
  extras: { browserSocket?: BrowserToolSocket } = {},
): Promise<{ client: EngineClient; sessionId: string; worker: EngineWorker }> {
  const daemon = await startEngine({ engineRoot: root(), workerLeaseMs: 1_000 });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  const project = await client.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  const session = await client.createSession({ id: "session_one", projectId: project.project.id });
  const worker = new EngineWorker({ client, workerId: "worker_one", driver, ...extras, pollMs: 60_000 });
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
  // The cwd is the project root CANONICALIZED, so the expectation has to be
  // canonicalized too rather than spelled out: registerProject was handed
  // "/tmp", which realpaths to /private/tmp on macOS and stays /tmp on Linux.
  // Hardcoding either one turns this into a platform assertion and fails in CI.
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
  const daemon = await startEngine({ engineRoot: root(), workerLeaseMs: 1_000 });
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
  const daemon = await startEngine({ engineRoot: root(), workerLeaseMs: 1_000 });
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

test("turns from DIFFERENT sessions run concurrently up to the cap; one session stays serial", async () => {
  // THE REPORTED BUG: creating several sessions queued their turns single-file
  // because the worker hard-capped itself at one active turn — the engine's
  // own rule was always per-session only.
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
  const daemon = await startEngine({ engineRoot: root(), workerLeaseMs: 1_000 });
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

test("a STOPPED first turn keeps the provider session — continuity survives the abort", async () => {
  // THE REPORTED BUG: stop landed before completeTurn (the only writer of the
  // resume cursor), so the next turn started a fresh provider session and the
  // human's context silently vanished. The driver now reports the id the
  // moment it learns it, and the engine persists it mid-turn.
  const seenCursor: Array<string | undefined> = [];
  const driver: TurnDriver = {
    async run({ providerSessionId, signal, onObservations }) {
      seenCursor.push(providerSessionId);
      if (seenCursor.length === 1) {
        // First turn: report the provider session early, then park until the
        // human stops the turn — the shape of a long generation.
        await onObservations([{ kind: "provider.session", providerSessionId: "provider-abc" }]);
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        throw new Error("stopped mid-generation");
      }
      return { text: "resumed fine" };
    },
  };
  const { client, sessionId, worker } = await setup(driver);
  await client.submitTurn(sessionId, { runId: "first", input: "One" });
  await worker.tick();
  await eventually(async () => expect((await client.session(sessionId)).turns[0]?.state).toBe("running"));
  await client.stopTurn(sessionId);
  await worker.tick();
  await eventually(async () => expect((await client.session(sessionId)).turns[0]?.state).toBe("stopped"));
  // The cursor survived the stop…
  expect((await client.session(sessionId)).session.resumeCursor).toBe("provider-abc");
  // …and the next turn RESUMES rather than starting fresh.
  await client.submitTurn(sessionId, { runId: "second", input: "Two" });
  await worker.tick();
  await eventually(async () => expect((await client.session(sessionId)).turns[1]?.state).toBe("completed"));
  expect(seenCursor).toEqual([undefined, "provider-abc"]);
});

// ── the browser lease ────────────────────────────────────────────────────────

const fakeBrowserSocket = () =>
  new BrowserToolSocket({
    call: async () => ({ content: [{ type: "text", text: "ok" }] }),
    isReadOnly: () => false,
    tools: [{ name: "browser_navigate", description: "go", input: { shape: {} } }],
    state: async () => ({ provider: "headless", tabs: [{ id: "0", url: "http://x", title: "X", active: true }] }),
  });

test("a session keeps ONE browser lease across its turns, revoked when the worker stops", async () => {
  /**
   * REVERSED FROM "the lease dies with the turn", deliberately. The lease's
   * url+token are baked into the provider's live process at creation, and
   * that process now OUTLIVES the turn (see ./claude-runtime.ts) — a per-run
   * token would invalidate the process's browser access the moment its first
   * turn settled. The validity window is now the SESSION's, ended by the
   * worker's own stop; per-turn authority lives in the gate, which is
   * re-pointed at each turn's claim.
   */
  const leases: Array<{ url: string; token: string }> = [];
  const driver: TurnDriver = {
    async run({ browserSocket }) {
      leases.push(browserSocket!);
      return { text: "done" };
    },
  };
  const socket = fakeBrowserSocket();
  const { client, sessionId, worker } = await setup(driver, { browserSocket: socket });
  try {
    await client.submitTurn(sessionId, { runId: "first", input: "One" });
    await worker.tick();
    await eventually(async () => expect((await client.session(sessionId)).turns[0]?.state).toBe("completed"));
    await client.submitTurn(sessionId, { runId: "second", input: "Two" });
    await worker.tick();
    await eventually(async () => expect((await client.session(sessionId)).turns[1]?.state).toBe("completed"));

    // Two turns of the SAME session: same endpoint, SAME credential — the
    // live provider process holds this token for the session's whole life.
    expect(leases).toHaveLength(2);
    expect(leases[0]!.url).toBe(leases[1]!.url);
    expect(leases[0]!.token).toBe(leases[1]!.token);

    // Between turns the token still authenticates…
    const between = await fetch(leases[1]!.url, {
      method: "POST",
      headers: { authorization: `Bearer ${leases[1]!.token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(between.status).toBe(200);

    // …and the worker's stop is the revocation.
    await worker.stop();
    const stale = await fetch(leases[1]!.url, {
      method: "POST",
      headers: { authorization: `Bearer ${leases[1]!.token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(stale.status).toBe(401);
  } finally {
    await socket.close();
  }
});

test("a mutating socket call journals browser.state onto the turn that made it", async () => {
  // THE WHOLE LOOP, over real HTTP: driver → socket → gate (auto-accepted by
  // the session's default mode) → browser → onNavigated → reportObservations.
  const driver: TurnDriver = {
    async run({ browserSocket }) {
      const response = await fetch(browserSocket!.url, {
        method: "POST",
        headers: { authorization: `Bearer ${browserSocket!.token}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "browser_navigate", arguments: {} } }),
      });
      const answer = (await response.json()) as { result: { isError?: boolean } };
      if (answer.result.isError) throw new Error("the socket declined a call the mode should have accepted");
      return { text: "done" };
    },
  };
  const socket = fakeBrowserSocket();
  const { client, sessionId, worker } = await setup(driver, { browserSocket: socket });
  try {
    await client.submitTurn(sessionId, { runId: "run_one", input: "Browse" });
    await worker.tick();
    await eventually(async () => expect((await client.session(sessionId)).turns[0]?.state).toBe("completed"));
    // The state report is asynchronous to the tool answer; it must still land
    // on THIS turn before it settles or arrive as this session's state.
    await eventually(async () => {
      const events = (await client.events(sessionId)).events;
      expect(events.some((event) => event.type === "browser.state.changed")).toBeTrue();
    });
  } finally {
    await socket.close();
  }
});

test("a wake-up between turns becomes a PROVIDER TURN on the engine, with its tool call decided under its own claim", async () => {
  /**
   * THE ROUND TRIP: driver (between turns) → session door → openProviderTurn
   * → a real running turn → its tool request opened under ITS claim → its
   * rows reported → completeTurn. Before this the frames waited for the next
   * human message and the tool call was refused against a settled claim.
   */
  let door: Parameters<TurnDriver["run"]>[0]["session"] | undefined;
  const driver: TurnDriver = {
    async run({ session }) {
      door = session;
      return { text: "first" };
    },
  };
  const { client, sessionId, worker } = await setup(driver);
  await client.submitTurn(sessionId, { runId: "run_one", input: "Watch CI" });
  await worker.tick();
  await eventually(async () => expect((await client.session(sessionId)).turns[0]?.state).toBe("completed"));
  expect(door).toBeDefined();

  // The shell ends between turns: no claim, no turn.
  await door!.onTasks([{ kind: "task.started", task: { id: "task_toolu_bg", kind: "background", state: "running", title: "Wait for CI" } }]);
  // (a start for a row nobody opened is dropped — see reportSessionTasks)
  expect((await client.session(sessionId)).tasks).toHaveLength(0);

  // The CLI wakes the model; the driver asks for a turn.
  const binding = await door!.onProviderTurn({ input: "Background task completed (green).", reason: { kind: "task_notification", taskId: "task_toolu_bg" } });
  expect(binding).toBeDefined();
  const snapshot = await client.session(sessionId);
  const providerTurn = snapshot.turns.find((turn) => turn.runId === binding!.runId);
  expect(providerTurn).toMatchObject({ state: "running", origin: "provider", input: "Background task completed (green)." });
  expect(snapshot.session.activity).toBe("working");

  // Its tool call is asked under ITS claim — and auto-accepted by the
  // session's default mode, exactly as a human turn's would be.
  const decision = await binding!.onRequest!({ kind: "file_read", detail: { kind: "file_read", read: { path: "/tmp/x" } }, toolUseId: "toolu_read" });
  expect(typeof decision === "string" ? decision : decision.decision).toBe("accept");
  await binding!.onObservations([
    { kind: "item.started", item: { id: "i_wake", detail: { type: "assistant_message", text: "merging" } } },
    { kind: "item.completed", itemId: "i_wake", status: "completed" },
  ]);
  await binding!.close({ text: "merged" });
  await eventually(async () => {
    const after = await client.session(sessionId);
    expect(after.turns.find((turn) => turn.runId === binding!.runId)).toMatchObject({ state: "completed", resultText: "merged" });
    expect(after.session.activity).toBe("idle");
  });
  const events = (await client.events(sessionId)).events.filter((event) => event.runId === binding!.runId).map((event) => event.type);
  expect(events).toEqual(["turn.accepted", "turn.claimed", "turn.started", "request.opened", "request.resolved", "item.started", "item.completed", "turn.completed"]);
});

test("a send-now delivery lands in the driver's mailbox and the promoted turn goes steered", async () => {
  // The driver plays a long turn: it waits for a steered message, drains it,
  // and answers with what it heard — proof the text crossed heartbeat →
  // mailbox → driver, and that the ack settled the promoted turn.
  const driver: TurnDriver = {
    async run({ steer }) {
      await steer!.wake();
      return { text: `heard:${steer!.drain().map((message) => message.text).join("|")}` };
    },
  };
  const { client, sessionId, worker } = await setup(driver);
  await client.submitTurn(sessionId, { runId: "run_live", input: "Long task" });
  await worker.tick();
  await eventually(async () => {
    expect((await client.session(sessionId)).turns.find((turn) => turn.runId === "run_live")?.state).toBe("running");
  });

  await client.submitTurn(sessionId, { runId: "run_next", input: "Also do this" });
  await client.promoteTurn(sessionId, "run_next");
  // The next heartbeat carries the delivery; the driver hears it and finishes.
  await worker.tick();
  await eventually(async () => {
    const turns = (await client.session(sessionId)).turns;
    expect(turns.find((turn) => turn.runId === "run_live")).toMatchObject({ state: "completed", resultText: "heard:Also do this" });
    expect(turns.find((turn) => turn.runId === "run_next")?.state).toBe("steered");
  });
});

test("a heartbeat WITHOUT a steer key still parses — the forward-compat default", async () => {
  // An older engine sends no steer array; the schema's .default([]) is what
  // keeps a newer worker from failing every heartbeat against it. Pinned at
  // the schema, where the guarantee lives.
  const { WorkerStatus } = await import("@telar/engine-client");
  const parsed = WorkerStatus.parse({ workerId: "worker_one", heartbeatAt: 1, cancel: [], resolved: [] });
  expect(parsed.steer).toEqual([]);
});
