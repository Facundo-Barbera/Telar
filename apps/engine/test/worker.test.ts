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

/**
 * A Claude default this temp home already knows, so a claim is not withheld
 * waiting for a model list nobody is going to read here. Real homes learn this
 * from the provider; see `rememberClaudeDefault`.
 */
const knownClaudeDefault = (directory: string): string => {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  return directory;
};

const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-worker-"));
  roots.push(directory);
  return knownClaudeDefault(directory);
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

/**
 * A BARRIER AT THE CLAIM PUMP'S BOUNDARIES, not a sleep.
 *
 * Claiming runs off the tick's await chain so a hung claim cannot hold
 * cancellations, approvals and steers behind it — which means `await tick()` no
 * longer implies the claim has been attempted. These tests are about what
 * happens AT the claim/provider boundary, so they wait for that boundary
 * explicitly. Nothing about what they assert changes.
 */
function claimBarrier() {
  const seen: string[] = [];
  let passes = 0;
  const wakers: Array<() => void> = [];
  return {
    seen,
    onClaimPhase: (phase: string) => {
      seen.push(phase);
      if (phase !== "idle") return;
      passes += 1;
      for (const wake of wakers.splice(0)) wake();
    },
    /**
     * Resolves after the NEXT pump pass completes. Counted rather than
     * latched: `start()` already runs a pass with an empty queue, so a latch
     * would be set before the pass this test cares about had begun.
     */
    async settled(): Promise<void> {
      const from = passes;
      const deadline = Date.now() + 4_000;
      while (passes === from && Date.now() < deadline) {
        await Promise.race([new Promise<void>((resolve) => wakers.push(resolve)), Bun.sleep(25)]);
      }
    },
  };
}

async function setup(
  driver: TurnDriver,
  extras: { browserSocket?: BrowserToolSocket; workerLeaseMs?: number } = {},
): Promise<{ client: EngineClient; sessionId: string; worker: EngineWorker }> {
  // Manual ticks need a lease covering the test; expiry is tested separately.
  const daemon = await startEngine({ engineRoot: root(), workerLeaseMs: extras.workerLeaseMs ?? 60_000 });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  const project = await client.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  const session = await client.createSession({ id: "session_one", projectId: project.project.id });
  const worker = new EngineWorker({ client, workerId: "worker_one", driver, ...(extras.browserSocket ? { browserSocket: extras.browserSocket } : {}), pollMs: 60_000 });
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
  let ready!: () => void;
  const providerReady = new Promise<void>(resolve => { ready = resolve; });
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
        ready();
      });
      return { text: "unreachable" };
    },
  };
  const { client, sessionId, worker } = await setup(driver);
  await client.submitTurn(sessionId, { runId: "run_one", input: "Stop me" });
  await worker.tick();
  await eventually(async () => expect((await client.session(sessionId)).turns[0]?.state).toBe("running"));
  await providerReady;
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
  const daemon = await startEngine({ engineRoot: root(), workerLeaseMs: 60_000 });
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
  const daemon = await startEngine({ engineRoot: root(), workerLeaseMs: 60_000 });
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

test("engine connectivity loss aborts active provider execution — once it outlasts the lease", async () => {
  /**
   * EXPECTATION CHANGED ON PURPOSE (#208). This used to assert that the FIRST
   * failed request aborted the turn. That is precisely the behaviour the
   * incident showed to be wrong: one loopback request that did not complete
   * aborted every active turn, replaced the worker, and killed every session's
   * background work — against a daemon whose PID never changed.
   *
   * The engine's own lease is now the budget (this test requests a 1s one, so the
   * worker learns a ~1s tolerance from `heartbeatIntervalMs`), and a REAL loss
   * — this daemon is genuinely closed — is still detected and still aborts,
   * just at the boundary the engine itself defines rather than instantly.
   */
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
  const { client, sessionId, worker } = await setup(driver, { workerLeaseMs: 1_000 });
  await client.submitTurn(sessionId, { runId: "run_one", input: "Hello" });
  await worker.tick();
  await eventually(async () => expect((await client.session(sessionId)).turns[0]?.state).toBe("running"));
  await daemons.at(-1)!.close();
  // The first failure starts the budget and changes nothing else: the turn is
  // still running, because a request that did not complete is not by itself
  // evidence that the engine is gone.
  await worker.tick();
  expect(sawAbort).toBe(false);
  // Past the engine's own lease it IS gone as far as this worker may assume,
  // and the abort lands.
  await Bun.sleep(1_100);
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
  const daemon = await startEngine({ engineRoot: root(), workerLeaseMs: 60_000 });
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
  let identified: (() => void) | undefined;
  // THE PRECONDITION, MADE REAL. This test is about losing an id that was
  // ALREADY REPORTED, so it must not stop the turn until the provider has
  // actually identified itself. Waiting on `running` is not that: the turn is
  // running the moment the driver is called, before it has said anything.
  const reported = new Promise<void>((resolve) => {
    identified = resolve;
  });
  const driver: TurnDriver = {
    async run({ providerSessionId, signal, onObservations }) {
      seenCursor.push(providerSessionId);
      if (seenCursor.length === 1) {
        // First turn: report the provider session early, then park until the
        // human stops the turn — the shape of a long generation.
        await onObservations([{ kind: "provider.session", providerSessionId: "provider-abc" }]);
        identified!();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        throw new Error("stopped mid-generation");
      }
      return { text: "resumed fine" };
    },
  };
  const { client, sessionId, worker } = await setup(driver);
  await client.submitTurn(sessionId, { runId: "first", input: "One" });
  await worker.tick();
  await reported;
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

test("a Stop that lands DURING setup stops, and the provider is never started", async () => {
  /**
   * The window `markTurnRunning`'s move created: the turn is claimed, the
   * worker is mid-setup, and the provider does not exist yet. Blocked on a real
   * setup await — the profile binding — rather than on timing.
   */
  let ran = 0;
  const driver: TurnDriver = {
    async run() {
      ran += 1;
      return { text: "should not happen" };
    },
  };
  let releaseBinding: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    releaseBinding = resolve;
  });
  let bindingEntered: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    bindingEntered = resolve;
  });
  const browserSocket = new BrowserToolSocket({
    call: async () => ({ content: [{ type: "text", text: "ok" }] }),
    isReadOnly: () => false,
    tools: [{ name: "browser_navigate", description: "go", input: { shape: {} } }],
    state: async () => ({ provider: "headless", tabs: [] }),
    bindProfile: async () => {
      bindingEntered!();
      await blocked;
    },
  });
  const { client, sessionId, worker } = await setup(driver, { browserSocket });

  await client.submitTurn(sessionId, { runId: "first", input: "One" });
  const ticking = worker.tick();
  // Parked inside setup: claimed, and NOT yet running — the provider has not
  // been asked for, so there is nothing to identify a session with.
  await entered;
  expect((await client.session(sessionId)).turns[0]?.state).toBe("claimed");

  await client.stopTurn(sessionId);
  expect((await client.session(sessionId)).turns[0]?.state).toBe("stopped");

  releaseBinding!();
  await ticking;

  // The stop stands — not overwritten by a failure — and nothing ever ran.
  await eventually(async () => expect((await client.session(sessionId)).turns[0]?.state).toBe("stopped"));
  expect(ran).toBe(0);
  // No provider identified itself, so there is no cursor to have kept. This is
  // the honest boundary: a Stop this early loses nothing, because nothing
  // existed yet — distinct from losing an id already reported (see above).
  expect((await client.session(sessionId)).session.resumeCursor).toBeUndefined();
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

test("sessions_send from a turn the CLI started on its own is proven by THAT turn's claim, not the settled one its capability was built in (#297)", async () => {
  /**
   * THE BUG IN #297, END TO END. `sessionsCapability` is assembled inside a
   * turn and then outlives it — the Claude wall reaches it through
   * `bindings.current.sessions`, which a provider turn does not replace, and
   * the Codex lease is bound once per session and reused. It used to close
   * over the runId and claim token of the turn that built it, so the moment
   * that turn settled every later `sessions_send` came back "turn has already
   * settled (completed)" while the CLI went on working. An orchestrator lost
   * every send it made for the rest of its session.
   *
   * The capability now reads the claim the worker is running under AT CALL
   * TIME, so a message sent from a wake-up is sent from the wake-up's turn.
   */
  let sessions: Parameters<TurnDriver["run"]>[0]["sessions"] | undefined;
  let door: Parameters<TurnDriver["run"]>[0]["session"] | undefined;
  const driver: TurnDriver = {
    async run(input) {
      sessions = input.sessions;
      door = input.session;
      return { text: "handed out the tasks" };
    },
  };
  const { client, sessionId, worker } = await setup(driver);
  const peer = (await client.createSession({ id: "session_two", projectId: "project_one" })).session;
  await client.submitTurn(sessionId, { runId: "run_one", input: "Coordinate" });
  await worker.tick();
  await eventually(async () => expect((await client.session(sessionId)).turns[0]?.state).toBe("completed"));
  expect(sessions).toBeDefined();

  // BETWEEN TURNS there is nothing live to send from, and the refusal says so
  // rather than blaming the token — see `requireSenderClaim`.
  await expect(sessions!.send(peer.id, { runId: "run_orphan", input: "brief" })).rejects.toThrow(/no live turn to send from/);

  // The CLI wakes up and the engine opens a real turn for it.
  const binding = await door!.onProviderTurn({ input: "Background task completed (green).", reason: { kind: "unknown" } });
  expect(binding).toBeDefined();

  // The SAME capability object — the one the wall is holding — now sends from
  // the live turn, attributed to this session and sourced to that run.
  const { turn } = await sessions!.send(peer.id, { runId: "run_brief", input: "your brief", intent: "task" });
  expect(turn).toMatchObject({ origin: "session", sender: { sessionId }, agentSourceRunId: binding!.runId });
  const delivered = (await client.session(peer.id)).turns.find((candidate) => candidate.runId === "run_brief");
  expect(delivered).toMatchObject({ input: "your brief", agentIntent: "task", sender: { sessionId } });
  await binding!.close({ text: "done" });
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

test("a WAKE steered into a running turn reaches the driver's mailbox still stamped as a wake (#194)", async () => {
  /**
   * THE WHOLE SEAM, over the real wire: a subscribed peer finishes while the
   * host is RUNNING, so the engine steers the wake instead of queueing it —
   * `submit → fireSubscriptions → steerForWorker → heartbeat → mailbox`. The
   * stamp used to die at `steerForWorker`, and everything downstream (the
   * provider's prompt, the transcript row) then had nothing to tell it the
   * words were the engine's rather than the person's.
   *
   * Asserted on what the DRIVER holds, not on a hand-built row: the mailbox is
   * the last point before the two drivers diverge.
   */
  const heardWake: Array<unknown> = [];
  const driver: TurnDriver = {
    async run({ prompt, steer }) {
      if (prompt !== "Long task") return { text: "child done" };
      await steer!.wake();
      for (const message of steer!.drain()) heardWake.push({ text: message.text.slice(0, 16), wakeReason: message.wakeReason, sender: message.sender });
      return { text: "host done" };
    },
  };
  const { client, sessionId, worker } = await setup(driver);
  const child = await client.createSession({ id: "session_two", projectId: "project_one", title: "the worker" });
  await client.subscribe(sessionId, { targetSessionId: child.session.id, events: ["turn_completed"] });

  await client.submitTurn(sessionId, { runId: "run_host", input: "Long task" });
  await worker.tick();
  await eventually(async () => {
    expect((await client.session(sessionId)).turns.find((turn) => turn.runId === "run_host")?.state).toBe("running");
  });

  // The child finishes WHILE the host runs — so its wake is steered, not queued.
  await client.submitTurn(child.session.id, { runId: "run_child", input: "child work" });
  await worker.tick();
  await eventually(async () => {
    const wake = (await client.session(sessionId)).turns.find((turn) => turn.origin === "session");
    expect(wake?.state).toBe("steering");
  });

  // The next heartbeat carries the delivery into the mailbox.
  await worker.tick();
  await eventually(() => {
    expect(heardWake).toHaveLength(1);
  });
  expect(heardWake[0]).toMatchObject({
    text: "[wake: completed",
    wakeReason: { kind: "turn_completed", sessionId: child.session.id, runId: "run_child" },
  });
  // A wake is nobody's message — not the person's, and not an agent's either.
  expect((heardWake[0] as { sender?: unknown }).sender).toBeUndefined();
});

test("a wake landing on an IDLE subscriber reaches the provider framed exactly as a steered one (#194)", async () => {
  // The other half of the pair above. Same happening, other landing site: no
  // turn is in flight, so the wake runs as its own turn and its framing comes
  // from `framedTurnInput` instead of the steer path. If these two ever
  // disagree, the model's evidence for "nobody typed this" depends on timing.
  const prompts: string[] = [];
  const driver: TurnDriver = {
    async run({ prompt }) {
      prompts.push(prompt);
      return { text: "ok" };
    },
  };
  const { client, sessionId, worker } = await setup(driver);
  const child = await client.createSession({ id: "session_two", projectId: "project_one", title: "the worker" });
  await client.subscribe(sessionId, { targetSessionId: child.session.id, events: ["turn_completed"] });

  // The host is IDLE throughout — nothing to steer into.
  await client.submitTurn(child.session.id, { runId: "run_child", input: "child work" });
  await worker.tick();
  await eventually(async () => {
    const wake = (await client.session(sessionId)).turns.find((turn) => turn.origin === "session");
    expect(wake).toBeDefined();
  });
  await worker.tick();

  await eventually(() => {
    expect(prompts.some((prompt) => prompt.startsWith("[engine wake · turn_completed · session "))).toBe(true);
  });
  const framed = prompts.find((prompt) => prompt.startsWith("[engine wake · "))!;
  expect(framed).toContain(child.session.id);
  expect(framed).toContain("Nobody typed it and no agent sent it");
  // The engine's own wake text is still all there, after the frame.
  expect(framed).toContain("[wake: completed]");
  // The child's own prompt was handed over bare — a person's words are not framed.
  expect(prompts).toContain("child work");
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
  const daemon = await startEngine({ engineRoot: root(), workerLeaseMs: 60_000 });
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

  const daemon = await startEngine({ engineRoot: root(), workerLeaseMs: 60_000 });
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
  const daemon = await startEngine({ engineRoot: root(), workerLeaseMs: 60_000 });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  await client.createSession({ id: "session_one", projectId: "project_one" });

  const barrier = claimBarrier();
  const worker = new EngineWorker({ client, workerId: "worker_one", driver, pollMs: 60_000, onClaimPhase: barrier.onClaimPhase });
  const realClaim = client.claimTurn.bind(client);
  client.claimTurn = async (workerId: string, claimSeq: number, signal?: AbortSignal) => {
    const claimed = await realClaim(workerId, claimSeq, signal);
    // The quit lands here — after the engine has handed out the claim, before
    // this worker has done anything with it.
    if (claimed.claim) await worker.stop();
    return claimed;
  };
  await worker.start();
  await client.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  await worker.tick();
  await barrier.settled();
  // The pump saw the grant and then STOPPED: it never reached the boundary
  // where a driver is constructed. That is the guarantee, stated directly.
  expect(barrier.seen).toContain("granted");
  expect(barrier.seen).not.toContain("starting");

  // No provider was spawned, and the turn is left exactly where the engine put
  // it: `claimed`. That is the safe state — `markTurnRunning` is ordered before
  // the driver is constructed precisely so `claimed` proves no provider ran,
  // which is why recovery requeues such a turn rather than holding it.
  expect(spawned).toEqual([]);
  const turns = (await client.session("session_one")).turns;
  expect(turns[0]?.state).toBe("claimed");

  // Boot terminalizes the abandoned claim without replaying its message.
  daemon.store.recover();
  const recovered = (await client.session("session_one")).turns[0];
  expect(recovered?.state).toBe("stopped");
  expect(recovered?.held).toBeUndefined();
});

test("a STOP makes no further provider call: the live turn ends, the backlog is settled, and the next message runs", async () => {
  /**
   * THE MEASURED FAILURE this began as: a stop was followed within a second by
   * a new run, because the requeued steer was claimed on the next heartbeat.
   * A pause fixed the symptom by holding everything until a human resumed —
   * which the person then rejected outright. Ending the backlog fixes the
   * cause: there is nothing left to claim, so no heartbeat can start anything,
   * and no Resume stands between the person and their next sentence.
   */
  const runs: string[] = [];
  const killedTasks: string[] = [];
  let killAttempts = 0;
  let release: (() => void) | undefined;
  const driver: TurnDriver = {
    async stopTask(sessionId, providerTaskId) {
      if (++killAttempts === 1) throw new Error("temporary provider control failure");
      killedTasks.push(`${sessionId}:${providerTaskId}`);
      return true;
    },
    async run({ prompt, signal, sessionId: ranOn, onObservations }) {
      if (ranOn === "session_one") runs.push(prompt);
      if (prompt === "Long task") {
        await onObservations([{ kind: "task.started", task: {
          id: "task_bg", kind: "background", state: "running", title: "Watch", providerTaskId: "provider_bg",
        } }]);
        await new Promise<void>((resolve) => {
          release = resolve;
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      return { text: `done:${prompt}` };
    },
  };
  const { client, sessionId, worker } = await setup(driver);
  const { session: supervisor } = await client.createSession({ id: "session_sup", projectId: "project_one" });
  await client.subscribe(supervisor.id, { targetSessionId: sessionId });

  await client.submitTurn(sessionId, { runId: "run_live", input: "Long task" });
  await worker.tick();
  await eventually(async () => expect((await client.session(sessionId)).turns[0]?.state).toBe("running"));
  expect((await client.submitTurn(sessionId, { runId: "run_steer", input: "steer me" })).turn.state).toBe("steering");
  await client.submitTurn(sessionId, { runId: "run_q1", input: "q1", kind: "compact" });
  expect((await client.submitTurn(sessionId, { runId: "run_q2", input: "q2" })).turn.state).toBe("steering");

  await eventually(() => expect(release).toBeDefined());
  const stopped = await client.stopSession(sessionId);
  expect(stopped.live?.runId).toBe("run_live");
  expect(stopped.stopped.map((turn) => turn.runId).sort()).toEqual(["run_live", "run_q1", "run_q2", "run_steer"]);

  // Several heartbeats: the cancel lands, the driver unwinds, and NOTHING new
  // is claimed — because nothing claimable is left.
  for (let i = 0; i < 5; i += 1) {
    await worker.tick();
    await Bun.sleep(15);
  }
  await eventually(async () => expect((await client.session(sessionId)).turns[0]?.state).toBe("stopped"));
  expect(runs).toEqual(["Long task"]);
  expect(killAttempts).toBe(2);
  expect(killedTasks).toEqual([`${sessionId}:provider_bg`]);
  expect((await client.session(sessionId)).tasks.find((task) => task.id === "task_bg")?.state).toBe("stopped");
  // Everything that was waiting is terminal, with its words intact.
  const settled = (await client.session(sessionId)).turns;
  expect(settled.filter((turn) => turn.state === "stopped").map((turn) => turn.runId).sort()).toEqual(["run_live", "run_q1", "run_q2", "run_steer"]);
  expect(settled.find((turn) => turn.runId === "run_q2")?.input).toBe("q2");
  expect(settled.every((turn) => turn.held === undefined)).toBe(true);
  // The supervisor heard about the live turn ending, once.
  const supTurns = (await client.session(supervisor.id)).turns;
  expect(supTurns.filter((turn) => turn.wakeReason?.kind === "turn_stopped")).toHaveLength(1);

  // AND THE NEXT MESSAGE JUST RUNS — no resume, no gesture.
  await client.submitTurn(sessionId, { runId: "run_typed", input: "typed after the stop" });
  for (let i = 0; i < 12 && runs.length < 2; i += 1) {
    await worker.tick();
    await Bun.sleep(20);
  }
  await eventually(async () => {
    const turns = (await client.session(sessionId)).turns;
    expect(turns.find((turn) => turn.runId === "run_typed")?.state).toBe("completed");
  });
  expect(runs).toEqual(["Long task", "typed after the stop"]);
  void release;
});

test("a claim already granted when Stop lands never reaches the driver; a new message continues", async () => {
  /**
   * THE RACE THE STORE TESTS CANNOT SEE. The daemon hands out a claim; the
   * pause lands while that response is still in flight to the worker; the
   * worker then receives a claim for a session that is now paused. The
   * pause STOPPED the claimed turn under the lock, so the worker's
   * `markTurnRunning` finds it `stopped` (a conflict), and the driver is
   * never constructed — zero provider calls, on the worker, not merely a
   * refused store claim. Driven deterministically: `claimTurn` is wrapped so
   * the pause happens inside the round trip.
   */
  const spawned: string[] = [];
  const driver: TurnDriver = {
    async run({ prompt }) {
      spawned.push(prompt);
      return { text: "must not run" };
    },
  };
  const daemon = await startEngine({ engineRoot: root(), workerLeaseMs: 60_000 });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  await client.createSession({ id: "session_one", projectId: "project_one" });
  const barrier = claimBarrier();
  const worker = new EngineWorker({ client, workerId: "worker_one", driver, pollMs: 60_000, onClaimPhase: barrier.onClaimPhase });
  workers.push(worker);
  const realClaim = client.claimTurn.bind(client);
  let pausedInFlight: Awaited<ReturnType<typeof client.pauseSession>> | undefined;
  client.claimTurn = async (workerId: string, claimSeq: number, signal?: AbortSignal) => {
    const claimed = await realClaim(workerId, claimSeq, signal);
    // The daemon has granted the claim; the human's pause lands before the
    // worker has seen the response.
    if (claimed.claim && !pausedInFlight) pausedInFlight = await client.pauseSession("session_one");
    return claimed;
  };
  await worker.start();
  await client.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  await client.submitTurn("session_one", { runId: "run_two", input: "Then this" });
  await worker.tick();
  await barrier.settled();
  // The compatibility pause endpoint stops both the claim and the backlog.
  expect(pausedInFlight).toMatchObject({ stopped: { runId: "run_one", state: "stopped" }, held: 0 });
  for (let i = 0; i < 4; i += 1) {
    await worker.tick();
    await Bun.sleep(15);
  }
  expect(spawned).toEqual([]);
  const turns = (await client.session("session_one")).turns;
  expect(turns.map((turn) => [turn.runId, turn.state, turn.held?.reason])).toEqual([
    ["run_one", "stopped", undefined],
    ["run_two", "stopped", undefined],
  ]);
  // No Resume and no replay: only a fresh user message runs.
  expect((await client.session("session_one")).session.paused).toBeUndefined();
  await client.submitTurn("session_one", { runId: "run_three", input: "Continue" });
  await worker.tick();
  await eventually(async () => expect((await client.session("session_one")).turns[2]?.state).toBe("completed"));
  expect(spawned).toEqual(["Continue"]);
});

/**
 * #409 — A STOP MUST NOT RIDE A POLL.
 *
 * THE MEASURED FAILURE: pressing Stop on a running Claude turn took up to five
 * seconds to take effect. Every party did its part promptly and the sum was
 * still seconds, because ONE HOP WAS A POLL. The engine writes `stopped`
 * synchronously in the request that carries the Stop, so the transcript was
 * never the slow part — but the worker holding the claim learned about it only
 * on its next heartbeat, and had to wait for the one in flight to answer first.
 * `onQueueChanged`'s doorbell could not help: it only lifts a BACKED-OFF worker
 * back onto its fast interval, and a worker with a turn running is never backed
 * off, so for the stop case it was exactly a no-op.
 *
 * These two tests pin both halves of the answer with a provider that IGNORES
 * the abort for three seconds — the shape of a long tool call.
 */
test("a Stop reaches an embedded worker's provider in-process, without waiting for a heartbeat", async () => {
  let abortedAt: number | undefined;
  let ready!: () => void;
  const running = new Promise<void>((resolve) => { ready = resolve; });
  const driver: TurnDriver = {
    async run({ signal, onObservations }) {
      await onObservations([{ kind: "item.started", item: { id: "i1", detail: { type: "assistant_message", text: "" } } }]);
      ready();
      signal.addEventListener("abort", () => { abortedAt = Date.now(); }, { once: true });
      // Ignores the stop, the way a CLI inside a long tool call does.
      await Bun.sleep(3_000);
      return { text: "too late" };
    },
  };
  /**
   * A HEARTBEAT DELIBERATELY TOO SLOW TO BE THE ANSWER. Two seconds is not the
   * production interval — it is the bound this test needs the fix to beat, and
   * it stands in for every real reason a beat is late (a busy daemon, a tick
   * already in flight, a worker that just backed off).
   */
  const daemon = await startEngine({
    engineRoot: root(),
    embeddedWorker: { createDriver: () => driver, pollMs: 2_000, idlePollMs: 2_000 },
  });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  await client.createSession({ id: "session_one", projectId: "project_one" });
  await client.submitTurn("session_one", { runId: "run_one", input: "Long task" });
  await running;

  const pressedAt = Date.now();
  await client.stopSession("session_one");
  await eventually(() => expect(abortedAt).toBeDefined());
  // The point of the whole change: well inside one heartbeat, not after it.
  expect(abortedAt! - pressedAt).toBeLessThan(1_000);
});

test("a provider that ignores a Stop never delays the turn's stopped state", async () => {
  // The provider is reaped in the background — its three seconds are its own,
  // and the person is not made to watch them.
  let ready!: () => void;
  const running = new Promise<void>((resolve) => { ready = resolve; });
  let returnedAfterStop = false;
  const driver: TurnDriver = {
    async run({ onObservations }) {
      await onObservations([{ kind: "item.started", item: { id: "i1", detail: { type: "assistant_message", text: "" } } }]);
      ready();
      await Bun.sleep(3_000);
      returnedAfterStop = true;
      return { text: "too late" };
    },
  };
  const daemon = await startEngine({
    engineRoot: root(),
    embeddedWorker: { createDriver: () => driver, pollMs: 2_000, idlePollMs: 2_000 },
  });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  await client.createSession({ id: "session_one", projectId: "project_one" });
  await client.submitTurn("session_one", { runId: "run_one", input: "Long task" });
  await running;

  const pressedAt = Date.now();
  const stopped = await client.stopSession("session_one");
  expect(stopped.live?.runId).toBe("run_one");
  // Read back through the API the cockpit reads, not from the return value.
  expect((await client.session("session_one")).turns[0]?.state).toBe("stopped");
  expect((await client.events("session_one")).events.at(-1)).toMatchObject({ type: "turn.stopped", runId: "run_one" });
  expect(Date.now() - pressedAt).toBeLessThan(300);
  // …and the provider really was still running when that was already true.
  expect(returnedAfterStop).toBe(false);
});

test("a Stop for another worker's claim is ignored, and the claim it does hold is aborted once", async () => {
  // `cancelClaims` is PUSHED rather than asked for, so the receiver has to
  // check the claim is its own — and the heartbeat carries the same
  // cancellation, so aborting twice must be the no-op it looks like.
  let aborts = 0;
  let ready!: () => void;
  const running = new Promise<void>((resolve) => { ready = resolve; });
  const driver: TurnDriver = {
    async run({ signal, onObservations }) {
      await onObservations([{ kind: "item.started", item: { id: "i1", detail: { type: "assistant_message", text: "" } } }]);
      ready();
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => { aborts += 1; resolve(); }, { once: true });
      });
      return { text: "stopped" };
    },
  };
  const { client, sessionId, worker } = await setup(driver);
  await client.submitTurn(sessionId, { runId: "run_one", input: "Stop me" });
  await worker.tick();
  await running;

  // Nobody else's claim moves this worker.
  worker.cancelClaims([{ claimToken: "tok_not_mine", workerId: "worker_two" }]);
  expect(aborts).toBe(0);

  await client.stopSession(sessionId);
  // This worker is out-of-process as far as the daemon is concerned, so the
  // heartbeat is its only delivery — and it must still work.
  await worker.tick();
  await eventually(() => expect(aborts).toBe(1));
  for (let i = 0; i < 3; i += 1) await worker.tick();
  expect(aborts).toBe(1);
});
