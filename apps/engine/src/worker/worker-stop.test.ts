import { afterEach, expect, test } from "bun:test";
import { EngineClient } from "@telar/engine-client";
import { BrowserToolSocket } from "../domains/browser";
import { startEngine } from "../daemon";
import type { TurnDriver } from "../drivers";
import { EngineWorker } from ".";
import { stubModels } from "../../test/stub-models";
import { eventually, until } from "../../test/wait";
import { daemons, root, setup, teardown, workers } from "../../test/worker-daemon";

afterEach(teardown);

/** A barrier at the claim pump's boundaries: claiming runs off the tick's await chain,
 *  so `await tick()` does not imply the claim was attempted. */
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
    /** Resolves after the next pump pass; counted, since `start()` already runs an empty pass. */
    async settled(): Promise<void> {
      const from = passes;
      const deadline = Date.now() + 4_000;
      while (passes === from && Date.now() < deadline) {
        await Promise.race([new Promise<void>((resolve) => wakers.push(resolve)), Bun.sleep(25)]);
      }
    },
  };
}

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

test("engine connectivity loss aborts active provider execution — once it outlasts the lease", async () => {
  // The engine's lease is the budget: a 1s lease here, and a genuinely closed daemon.
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
  // The first failure starts the budget and changes nothing else.
  await worker.tick();
  expect(sawAbort).toBe(false);
  // Past the lease the abort lands; heartbeat until it does rather than sleeping.
  await until("the lease to lapse and the abort to land", async () => {
    await worker.tick();
    return sawAbort;
  });
  expect(sawAbort).toBe(true);
});

test("a STOPPED first turn keeps the provider session — continuity survives the abort", async () => {
  // The driver reports the provider session id as it learns it, and the engine persists it mid-turn.
  const seenCursor: Array<string | undefined> = [];
  let identified: (() => void) | undefined;
  // Stop only once the provider has identified itself; `running` comes earlier.
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
  // Claimed, mid-setup, no provider yet: blocked on the profile binding, not on timing.
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
  // No provider identified itself, so there is no cursor to have kept.
  expect((await client.session(sessionId)).session.resumeCursor).toBeUndefined();
});

test("a shutdown landing inside an in-flight claim leaves the turn claimed, never running", async () => {
  // `stop()` can finish entirely between the claim request and its response;
  // `claimTurn` is wrapped so it does, deterministically.
  const spawned: string[] = [];
  const driver: TurnDriver = {
    async run({ prompt }) {
      spawned.push(prompt);
      return { text: "should never run" };
    },
  };
  const daemon = await startEngine({ models: stubModels, engineRoot: root(), workerLeaseMs: 60_000 });
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

  // `claimed` is the safe state: `markTurnRunning` precedes the driver, so it proves no provider ran.
  expect(spawned).toEqual([]);
  const turns = (await client.session("session_one")).turns;
  expect(turns[0]?.state).toBe("claimed");

  // Boot terminalizes the abandoned claim without replaying its message.
  daemon.store.recovery.recover();
  const recovered = (await client.session("session_one")).turns[0];
  expect(recovered?.state).toBe("stopped");
  expect(recovered?.held).toBeUndefined();
});

test("a STOP makes no further provider call: the live turn ends, the backlog is settled, and the next message runs", async () => {
  // Ending the backlog leaves nothing to claim, so no heartbeat can start anything.
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
  // The pause lands inside the claim round trip, so `markTurnRunning` finds the
  // turn `stopped` and the driver is never constructed.
  const spawned: string[] = [];
  const driver: TurnDriver = {
    async run({ prompt }) {
      spawned.push(prompt);
      return { text: "must not run" };
    },
  };
  const daemon = await startEngine({ models: stubModels, engineRoot: root(), workerLeaseMs: 60_000 });
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

// A Stop must not ride a poll; the provider below ignores its abort, like a long tool call.
test("a Stop reaches an embedded worker's provider in-process, without waiting for a heartbeat", async () => {
  let abortedAt: number | undefined;
  let ready!: () => void;
  const running = new Promise<void>((resolve) => { ready = resolve; });
  // Held open by the test, not by a clock.
  let providerMayReturn = false;
  const driver: TurnDriver = {
    async run({ signal, onObservations }) {
      await onObservations([{ kind: "item.started", item: { id: "i1", detail: { type: "assistant_message", text: "" } } }]);
      ready();
      signal.addEventListener("abort", () => { abortedAt = Date.now(); }, { once: true });
      // Ignores the stop, the way a CLI inside a long tool call does.
      await until("the test to release the provider", () => providerMayReturn);
      return { text: "too late" };
    },
  };
  // A heartbeat deliberately too slow to be the answer.
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
  // Only now may the provider unwind, so nothing above raced its return.
  providerMayReturn = true;
});

test("a provider that ignores a Stop never delays the turn's stopped state", async () => {
  // The provider is reaped in the background.
  let ready!: () => void;
  const running = new Promise<void>((resolve) => { ready = resolve; });
  let returnedAfterStop = false;
  // Held open by the test, not by a clock.
  let providerMayReturn = false;
  const driver: TurnDriver = {
    async run({ onObservations }) {
      await onObservations([{ kind: "item.started", item: { id: "i1", detail: { type: "assistant_message", text: "" } } }]);
      ready();
      await until("the test to release the provider", () => providerMayReturn);
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
  const lastEvent = (await client.events("session_one")).events.at(-1);
  expect(lastEvent).toMatchObject({ type: "turn.stopped", runId: "run_one" });

  // Measured on the engine's clock: both timestamps are the engine's own and
  // nothing between them crosses a socket.
  expect(stopped.live?.completedAt).toBeDefined();
  expect(lastEvent!.at - stopped.live!.completedAt!).toBeLessThan(300);
  // A loose wall-clock ceiling for hangs the engine's timestamps cannot see.
  expect(Date.now() - pressedAt).toBeLessThan(2_000);
  // …and the provider really was still running when that was already true.
  expect(returnedAfterStop).toBe(false);
  providerMayReturn = true;
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
