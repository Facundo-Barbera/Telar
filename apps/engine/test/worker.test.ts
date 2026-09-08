import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient } from "@telar/engine-client";
import { BrowserToolSocket } from "../src/browser/socket";
import { startEngine, type EngineDaemon } from "../src/daemon";
import { ProviderUnavailableError, type TurnDriver } from "../src/driver";
import { defaultWorkerConcurrency, EngineWorker } from "../src/worker";

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

async function eventually(check: () => void | Promise<void>, deadlineMs = 4_000): Promise<void> {
  // A wall-clock bound (below bun's 5s test timeout), not a retry count: the
  // former 60×5ms window was ~300ms only when each check was instant, and
  // one full-gate run under load failed it. Settles on the first pass.
  const deadline = Date.now() + deadlineMs;
  let last: unknown;
  do {
    try {
      await check();
      return;
    } catch (error) {
      last = error;
      await Bun.sleep(20);
    }
  } while (Date.now() < deadline);
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

const fakeBrowserSocket = (beforeState: () => Promise<void> = async () => {}) =>
  new BrowserToolSocket({
    call: async () => ({ content: [{ type: "text", text: "ok" }] }),
    isReadOnly: () => false,
    tools: [{ name: "browser_navigate", description: "go", input: { shape: {} } }],
    state: async () => {
      await beforeState();
      return { provider: "headless", tabs: [{ id: "0", url: "http://x", title: "X", active: true }] };
    },
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
      // A successful tool reply now includes completion of its state journal,
      // so the provider may finish immediately without losing the panel state.
      expect((await client.events(sessionId)).events.some((event) => event.type === "browser.state.changed")).toBeTrue();
      return { text: "done" };
    },
  };
  // Delay the state read past the HTTP tool reply in the old fire-and-forget path.
  const socket = fakeBrowserSocket(() => Bun.sleep(30));
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

test("a message submitted mid-turn lands in the driver's mailbox and goes steered", async () => {
  // The driver plays a long turn: it waits for a steered message, drains it,
  // and answers with what it heard — proof the text crossed submit → heartbeat
  // → mailbox → driver, and that the ack settled the steered turn.
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

  // No "Send now": submitting while the turn runs IS the steer.
  const accepted = await client.submitTurn(sessionId, { runId: "run_next", input: "Also do this" });
  expect(accepted.turn.state).toBe("steering");
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

test("a project folder that no longer exists fails the turn with the folder named — never a spawn", async () => {
  const { assertProjectRoot } = await import("../src/worker");
  expect(() => assertProjectRoot("/definitely/not/here/telar-integration")).toThrow(/does not exist.*moved or deleted.*re-register/i);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "telar-root-")), "file.txt");
  fs.writeFileSync(file, "x");
  expect(() => assertProjectRoot(file)).toThrow(/not a folder/);
  expect(() => assertProjectRoot(os.tmpdir())).not.toThrow();
  // Through the worker: the driver is never invoked; the turn fails with the sentence.
  let invoked = 0;
  const driver: TurnDriver = { run: async () => { invoked += 1; return { text: "" }; } };
  const daemon = await startEngine({ engineRoot: root(), workerLeaseMs: 1_000 });
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

test("the claim carries the session's project id and the worker binds the browser profile BEFORE the turn's tools run", async () => {
  const bound: Array<[string, string]> = [];
  const socket = new BrowserToolSocket({
    call: async () => ({ content: [] }),
    isReadOnly: () => true,
    tools: [],
    bindProfile: async (scopeKey, profileKey) => { bound.push([scopeKey, profileKey]); },
  });
  const order: string[] = [];
  const driver: TurnDriver = { run: async () => { order.push(`run:${bound.length}`); return { text: "ok" }; } };
  const { client, sessionId, worker } = await setup(driver, { browserSocket: socket });
  await client.submitTurn(sessionId, { runId: "run_bind", input: "Hello" });
  await worker.tick();
  await eventually(async () => expect((await client.session(sessionId)).turns[0]).toMatchObject({ state: "completed" }));
  expect(bound).toEqual([[sessionId, "project_one"]]);
  expect(order).toEqual(["run:1"]); // bound before the driver ran
});

test("a browser profile binding the host REFUSES does not fail the turn — the provider still runs", async () => {
  // Release-review finding: an older desktop shell without a /bind route
  // answered 404, `bindProfile` threw before `driver.run`, and every turn on
  // the machine failed as `driver_failed: Not found.` with no browser tool
  // involved. The binding is re-issued by the router before each browser
  // tool call, so a refusal belongs to the call that needs it — not here.
  const socket = new BrowserToolSocket({
    call: async () => ({ content: [] }),
    isReadOnly: () => true,
    tools: [],
    bindProfile: async () => { throw new Error("Not found."); },
  });
  let ran = 0;
  const driver: TurnDriver = { run: async () => { ran += 1; return { text: "ok" }; } };
  const { client, sessionId, worker } = await setup(driver, { browserSocket: socket });
  await client.submitTurn(sessionId, { runId: "run_bind_refused", input: "Hello" });
  await worker.tick();
  await eventually(async () => expect((await client.session(sessionId)).turns[0]).toMatchObject({ state: "completed" }));
  expect(ran).toBe(1);
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
  /**
   * THE REPORTED SYMPTOM: four conversations running, one of them woken by a
   * background task rather than by a human, and a newly typed message sat at
   * "queued" with a slot that was never scheduled through the gate holding it.
   */
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

  const daemon = await startEngine({ engineRoot: root(), workerLeaseMs: 1_000 });
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

test("a shutdown landing inside an in-flight claim leaves the turn claimed, never running", async () => {
  /**
   * THE RACE. `claimTurn` is a round trip, and `stop()` runs on its own
   * schedule: it can set `stopped`, abort what it knows about and finish
   * waiting on the in-flight runs entirely BETWEEN the claim request and its
   * response. Without the re-check after the await, `execute` starts anyway —
   * it calls `markTurnRunning` on a worker that is already dismantling itself,
   * after the only wait that would have settled the turn, so the next boot
   * finds it `running` and calls it `ambiguous`. Ambiguous for a turn that
   * never reached a provider at all.
   *
   * Driven deterministically rather than by timing: the client's `claimTurn` is
   * wrapped so `stop()` completes inside the call.
   */
  const spawned: string[] = [];
  const driver: TurnDriver = {
    async run({ prompt }) {
      spawned.push(prompt);
      return { text: "should never run" };
    },
  };
  const daemon = await startEngine({ engineRoot: root(), workerLeaseMs: 1_000 });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  await client.createSession({ id: "session_one", projectId: "project_one" });

  const worker = new EngineWorker({ client, workerId: "worker_one", driver, pollMs: 60_000 });
  const realClaim = client.claimTurn.bind(client);
  client.claimTurn = async (workerId: string) => {
    const claimed = await realClaim(workerId);
    // The quit lands here — after the engine has handed out the claim, before
    // this worker has done anything with it.
    if (claimed.claim) await worker.stop();
    return claimed;
  };
  await worker.start();
  await client.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  await worker.tick();

  // No provider was spawned, and the turn is left exactly where the engine put
  // it: `claimed`. That is the safe state — `markTurnRunning` is ordered before
  // the driver is constructed precisely so `claimed` proves no provider ran,
  // which is why recovery requeues such a turn rather than holding it.
  expect(spawned).toEqual([]);
  const turns = (await client.session("session_one")).turns;
  expect(turns[0]?.state).toBe("claimed");

  // And recovery does exactly that: back to `queued`, unheld, ready to run.
  daemon.store.recover();
  const recovered = (await client.session("session_one")).turns[0];
  expect(recovered?.state).toBe("queued");
  expect(recovered?.held).toBeUndefined();
});
