import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient, EngineClientError } from "@telar/engine-client";
import { startEngine } from "../daemon";
import { EngineWorker } from ".";
import { stubModels } from "../../test/stub-models";
import { fakeClient, fakeClock, HEARTBEAT_INTERVAL_MS, idle, workerFor } from "./connectivity-fixture";

/** Past the worker's capped retry spacing, so a drain is due. */
const SETTLE_SPACING_MS = 31_000;

/** A Claude default this temp home already knows, so a claim is not withheld waiting for a model list. */
function knownClaudeDefault(directory: string): string {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  return directory;
}


/** A barrier at the claim pump's boundary: claiming runs off the tick's await chain, so `await tick()`
 *  does not imply a claim was attempted. Counted, since `start()` already runs an empty pass. */
function claimBarrier() {
  let passes = 0;
  const wakers: Array<() => void> = [];
  return {
    onClaimPhase: (phase: string) => {
      if (phase !== "idle") return;
      passes += 1;
      for (const wake of wakers.splice(0)) wake();
    },
    async settled(): Promise<void> {
      const from = passes;
      const deadline = Date.now() + 4_000;
      while (passes === from && Date.now() < deadline) {
        await Promise.race([new Promise<void>((resolve) => wakers.push(resolve)), Bun.sleep(25)]);
      }
    },
  };
}

/** Wait for the store to actually hold a terminal state — the drain runs off
 *  the tick, so a tick returning is not the settlement landing. */
async function settled(client: EngineClient, sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await client.session(sessionId)).turns[0]?.state !== "running") return;
    await Bun.sleep(5);
  }
}

test("a lost settlement response is retried as ITSELF, against the real engine store", async () => {
  // The wrapper drops the response, so the first write commits and the retry
  // meets the engine's own conflict.
  const home = knownClaudeDefault(fs.mkdtempSync(path.join(os.tmpdir(), "telar-settle-")));
  const daemon = await startEngine({ models: stubModels, engineRoot: home, workerLeaseMs: 5_000 });
  try {
    const client = new EngineClient(daemon.discovery);
    const project = await client.registerProject({ id: "project_one", name: "One", root: "/tmp" });
    const session = await client.createSession({ id: "session_one", projectId: project.project.id });

    // The response to the FIRST completeTurn is thrown away after the engine
    // has already applied it — exactly a lost acknowledgement.
    let swallowed = 0;
    const real = client.completeTurn.bind(client);
    (client as unknown as { completeTurn: typeof client.completeTurn }).completeTurn = async (...args) => {
      const answer = await real(...args);
      if (swallowed === 0) {
        swallowed += 1;
        throw new EngineClientError("engine_unavailable", "engine is unreachable", undefined, { operation: "completeTurn", transport: "TypeError:ECONNRESET" });
      }
      return answer;
    };

    const diagnostics: Record<string, unknown>[] = [];
    const barrier = claimBarrier();
    const worker = new EngineWorker({
      client,
      onClaimPhase: barrier.onClaimPhase,
      workerId: "worker_settle",
      driver: { run: async () => ({ text: "the answer", usage: { tokens: { input: 5, output: 7, cacheRead: 0, cacheCreate: 0 } } }) },
      pollMs: 60_000,
      pause: async () => {},
      onDiagnostic: (fields) => void diagnostics.push(fields),
    });
    await worker.start();
    await client.submitTurn(session.session.id, { runId: "run_one", input: "Hello" });
    await worker.tick();
    await barrier.settled();

    // The turn is COMPLETED with its own text and usage — not interrupted.
    const turn = (await client.session(session.session.id)).turns[0];
    expect(turn?.state).toBe("completed");
    expect(turn?.failure).toBeUndefined();
    expect(swallowed).toBe(1);
    // The retry met the engine's real conflict and treated it as settled.
    expect(diagnostics.some((line) => line.event === "turn_unsettled")).toBeFalse();
    await worker.stop();
  } finally {
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}, 20_000);


test("five failures BEFORE commit, then a recovered endpoint: the turn resolves with its ORIGINAL result", async () => {
  // The first five `completeTurn` attempts fail before reaching the engine,
  // heartbeats keep succeeding, and the endpoint then recovers.
  const home = knownClaudeDefault(fs.mkdtempSync(path.join(os.tmpdir(), "telar-settle-late-")));
  const daemon = await startEngine({ models: stubModels, engineRoot: home, workerLeaseMs: 60_000 });
  try {
    const client = new EngineClient(daemon.discovery);
    const project = await client.registerProject({ id: "project_one", name: "One", root: "/tmp" });
    const session = await client.createSession({ id: "session_one", projectId: project.project.id });

    let refusals = 0;
    const real = client.completeTurn.bind(client);
    (client as unknown as { completeTurn: typeof client.completeTurn }).completeTurn = async (...args) => {
      if (refusals < 5) {
        refusals += 1;
        // Never reaches the engine: no commit, so no conflict later.
        throw new EngineClientError("engine_unavailable", "engine is unreachable", undefined, { operation: "completeTurn", transport: "TypeError:ECONNRESET" });
      }
      return real(...args);
    };

    const diagnostics: Record<string, unknown>[] = [];
    const clock = fakeClock();
    const barrier = claimBarrier();
    const worker = new EngineWorker({
      client,
      now: clock.now,
      onClaimPhase: barrier.onClaimPhase,
      workerId: "worker_late",
      driver: { run: async () => ({ text: "the answer", usage: { tokens: { input: 5, output: 7, cacheRead: 0, cacheCreate: 0 } } }) },
      pollMs: 60_000,
      pause: async () => {},
      onDiagnostic: (fields) => void diagnostics.push(fields),
    });
    await worker.start();
    await client.submitTurn(session.session.id, { runId: "run_one", input: "Hello" });
    await worker.tick();
    await barrier.settled();

    // All five inline attempts were spent and the turn is NOT settled yet —
    // but it is retained rather than abandoned.
    expect(refusals).toBe(5);
    expect(diagnostics.some((line) => line.event === "turn_settlement_pending")).toBeTrue();
    expect((await client.session(session.session.id)).turns[0]?.state).toBe("running");

    // A later healthy tick pushes it — no provider re-run, no new claim. The
    // drain runs off the tick, so it is awaited by settling rather than by the
    // tick returning.
    clock.advance(SETTLE_SPACING_MS);
    await worker.tick();
    await settled(client, session.session.id);
    const turn = (await client.session(session.session.id)).turns[0];
    expect(turn?.state).toBe("completed");
    expect(turn?.failure).toBeUndefined();
    // The ORIGINAL outcome, not a substituted one.
    expect(diagnostics.some((line) => line.event === "turn_settled_late")).toBeTrue();
    await worker.stop();
  } finally {
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}, 20_000);

test("a settle that hangs is bounded, and a stop inside the backoff sends nothing more", async () => {
  const fake = fakeClient({ register: { heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS } });
  const diagnostics: Record<string, unknown>[] = [];
  let sends = 0;
  let aborted = 0;
  fake.client.failTurn = async (..._args: unknown[]) => {
    sends += 1;
    const signal = _args[4] as AbortSignal | undefined;
    return new Promise((_resolve, reject) => {
      // Only the caller's own bound can end this.
      signal?.addEventListener("abort", () => {
        aborted += 1;
        reject(new DOMException("timed out", "TimeoutError"));
      }, { once: true });
    });
  };
  const worker = workerFor(fake, () => undefined, { count: 0 }, { diagnostics });
  await worker.start();
  const settle = (worker as unknown as { settle: (e: Record<string, unknown>) => Promise<string> }).settle.bind(worker);
  const running = settle({
    sessionId: "s",
    runId: "run_hang",
    claimToken: "t",
    operation: "failTurn",
    send: (signal: AbortSignal) => (fake.client.failTurn as (...a: unknown[]) => Promise<unknown>)("s", "run_hang", "t", {}, signal),
  });
  // The stop lands while the settle is between attempts.
  await Bun.sleep(5);
  await worker.stop();
  await running;
  // Every attempt was bounded by its signal rather than hanging…
  expect(aborted).toBeGreaterThan(0);
  // …and the stop ended it: nowhere near the five inline attempts.
  expect(sends).toBeLessThan(5);
}, 30_000);

test("a REVOKED pre-settlement fault revokes the worker even when the settle then succeeds", async () => {
  // A successful `failTurn` must not bury an `engine_unauthorized` from `markTurnRunning`.
  const home = knownClaudeDefault(fs.mkdtempSync(path.join(os.tmpdir(), "telar-revoked-")));
  const daemon = await startEngine({ models: stubModels, engineRoot: home, workerLeaseMs: 60_000 });
  try {
    const client = new EngineClient(daemon.discovery);
    const project = await client.registerProject({ id: "project_one", name: "One", root: "/tmp" });
    const session = await client.createSession({ id: "session_one", projectId: project.project.id });
    (client as unknown as { markTurnRunning: () => Promise<unknown> }).markTurnRunning = async () => {
      throw new EngineClientError("engine_unauthorized", "refused", 401, { operation: "markTurnRunning" });
    };
    const diagnostics: Record<string, unknown>[] = [];
    let lost = 0;
    const barrier = claimBarrier();
    const worker = new EngineWorker({
      client,
      onClaimPhase: barrier.onClaimPhase,
      workerId: "worker_revoked",
      driver: { run: async () => ({ text: "" }) },
      pollMs: 60_000,
      pause: async () => {},
      onConnectionLost: () => void (lost += 1),
      onDiagnostic: (fields) => void diagnostics.push(fields),
    });
    await worker.start();
    await client.submitTurn(session.session.id, { runId: "run_one", input: "Hello" });
    await worker.tick();
    await barrier.settled();
    // The ENGINE's verdict wins, and is recorded against the call that failed.
    expect(lost).toBe(1);
    const terminal = diagnostics.find((line) => line.event === "connection_lost");
    expect(terminal).toMatchObject({ code: "engine_unauthorized", operation: "markTurnRunning" });
    await worker.stop();
  } finally {
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}, 20_000);

test("a settlement is NEVER forgotten on a retry count: >20 rounds, then the endpoint recovers", async () => {
  // Retention is bounded by the lease and a capped backoff, never by a round count.
  const home = knownClaudeDefault(fs.mkdtempSync(path.join(os.tmpdir(), "telar-settle-forever-")));
  const daemon = await startEngine({ models: stubModels, engineRoot: home, workerLeaseMs: 60_000 });
  try {
    const client = new EngineClient(daemon.discovery);
    const project = await client.registerProject({ id: "project_one", name: "One", root: "/tmp" });
    const session = await client.createSession({ id: "session_one", projectId: project.project.id });
    // Refuses until the test says otherwise — a count would let the turn settle
    // inside the retention loop and prove nothing about forgetting.
    let refusing = true;
    let refusals = 0;
    const real = client.completeTurn.bind(client);
    (client as unknown as { completeTurn: typeof client.completeTurn }).completeTurn = async (...args) => {
      if (refusing) {
        refusals += 1;
        throw new EngineClientError("engine_unavailable", "engine is unreachable", undefined, { operation: "completeTurn", transport: "TypeError:ECONNRESET" });
      }
      return real(...args);
    };
    const clock = fakeClock();
    const barrier = claimBarrier();
    const worker = new EngineWorker({
      client,
      now: clock.now,
      onClaimPhase: barrier.onClaimPhase,
      workerId: "worker_forever",
      driver: { run: async () => ({ text: "the answer", usage: { tokens: { input: 5, output: 7, cacheRead: 0, cacheCreate: 0 } } }) },
      pollMs: 60_000,
      pause: async () => {},
      onDiagnostic: () => {},
    });
    await worker.start();
    await client.submitTurn(session.session.id, { runId: "run_one", input: "Hello" });
    await worker.tick();
    await barrier.settled();

    // Far past any previous cap. Heartbeats stay healthy throughout.
    for (let round = 0; round < 40; round += 1) {
      clock.advance(SETTLE_SPACING_MS);
      await worker.tick();
      await Bun.sleep(1);
    }
    // Still remembered after far more rounds than any previous cap — the point.
    expect(refusals).toBeGreaterThan(20);
    expect((worker as unknown as { pendingSettlements: Map<string, unknown> }).pendingSettlements.size).toBe(1);
    expect((await client.session(session.session.id)).turns[0]?.state).toBe("running");

    refusing = false;

    for (let round = 0; round < 5 && (await client.session(session.session.id)).turns[0]?.state !== "completed"; round += 1) {
      clock.advance(SETTLE_SPACING_MS);
      await worker.tick();
      await Bun.sleep(5);
    }
    // THE STORE, not a diagnostic: the original outcome, with its own usage.
    const turn = (await client.session(session.session.id)).turns[0];
    expect(turn?.state).toBe("completed");
    expect(turn?.failure).toBeUndefined();
    expect((worker as unknown as { pendingSettlements: Map<string, unknown> }).pendingSettlements.size).toBe(0);
    await worker.stop();
  } finally {
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}, 30_000);

test("hung settlements never starve the heartbeat: no global loss, cancellations still delivered", async () => {
  // Awaiting the drain inside `tick` would let hung endpoints starve the lease.
  const fake = fakeClient({ register: { heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS } });
  let lost = 0;
  const cancels: string[] = [];
  // Three settlements that never answer until their own signal fires.
  fake.client.failTurn = async (..._args: unknown[]) =>
    new Promise((_resolve, reject) => {
      (_args[4] as AbortSignal | undefined)?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")), { once: true });
    });
  const worker = workerFor(fake, () => void (lost += 1), { count: 0 });
  await worker.start();
  const pending = (worker as unknown as { pendingSettlements: Map<string, unknown> }).pendingSettlements;
  for (const runId of ["run_a", "run_b", "run_c"]) {
    pending.set(runId, {
      sessionId: "s",
      runId,
      claimToken: "t",
      operation: "failTurn",
      send: (signal: AbortSignal) => (fake.client.failTurn as (...a: unknown[]) => Promise<unknown>)("s", runId, "t", {}, signal),
      since: Date.now(),
      rounds: 0,
      nextAttemptAt: 0,
    });
  }

  // A cancellation arrives while all three settlements are hung.
  const original = fake.client.workerHeartbeat as () => Promise<unknown>;
  let served = 0;
  fake.client.workerHeartbeat = async () => {
    served += 1;
    await original();
    return served === 2 ? { ...idle, cancel: [{ sessionId: "s", runId: "run_z", claimToken: "claim_z" }] } : idle;
  };
  const seen = new AbortController();
  (worker as unknown as { active: Map<string, AbortController> }).active.set("claim_z", seen);
  seen.signal.addEventListener("abort", () => cancels.push("run_z"), { once: true });

  // Ticks return promptly rather than queueing behind the hung drains.
  const before = Date.now();
  await worker.tick();
  await worker.tick();
  const elapsed = Date.now() - before;
  expect(elapsed).toBeLessThan(1_000);
  // The cancellation was delivered, and no session was lost.
  expect(cancels).toEqual(["run_z"]);
  expect(lost).toBe(0);
  await worker.stop();
}, 30_000);

test("one settlement the engine keeps refusing does not block the next, and is spaced not spun", async () => {
  const clock = fakeClock();
  // A lease that outlasts the backoff: past the lease a settle sends nothing.
  const fake = fakeClient({ register: { heartbeatIntervalMs: 10_000 } });
  const diagnostics: Record<string, unknown>[] = [];
  let refusals = 0;
  let settledSecond = 0;
  const worker = workerFor(fake, () => undefined, { count: 0 }, { clock, diagnostics });
  await worker.start();
  const pending = (worker as unknown as { pendingSettlements: Map<string, { rounds: number; nextAttemptAt: number }> }).pendingSettlements;
  const retain = (worker as unknown as { retain: (e: Record<string, unknown>) => void }).retain.bind(worker);

  // First: refuses forever with a non-connectivity error. Second: fine.
  retain({
    sessionId: "s",
    runId: "run_bad",
    claimToken: "t",
    operation: "failTurn",
    send: async () => {
      refusals += 1;
      throw new EngineClientError("invalid_request", "no", 400, { operation: "failTurn" });
    },
  });
  retain({
    sessionId: "s",
    runId: "run_good",
    claimToken: "t",
    operation: "completeTurn",
    send: async () => {
      settledSecond += 1;
    },
  });
  // Both are due now.
  for (const entry of pending.values()) entry.nextAttemptAt = 0;

  const drain = (worker as unknown as { startDrain: () => void }).startDrain.bind(worker);
  drain();
  await Bun.sleep(20);

  // THE SECOND ENTRY SETTLED despite the first refusing — the whole point.
  expect(settledSecond).toBe(1);
  expect(pending.has("run_good")).toBeFalse();
  // The refusing one is still held (never dropped on a count) and is now SPACED
  // rather than eligible on the next tick.
  expect(pending.has("run_bad")).toBeTrue();
  expect(pending.get("run_bad")!.nextAttemptAt).toBeGreaterThan(clock.now());
  expect(refusals).toBe(1);

  // A tick before its backoff elapses does not touch it.
  drain();
  await Bun.sleep(20);
  expect(refusals).toBe(1);
  // Once the spacing has passed it is attempted again — retained, not forgotten.
  clock.advance(2_000);
  for (const entry of pending.values()) entry.nextAttemptAt = 0;
  drain();
  await Bun.sleep(20);
  expect(refusals).toBe(2);
  expect(pending.has("run_bad")).toBeTrue();
  expect(diagnostics.some((line) => line.event === "turn_settlement_refused" && line.code === "invalid_request")).toBeTrue();
  await worker.stop();
});

test("a turn the engine no longer has is VACATED, not held for something that cannot exist", async () => {
  const clock = fakeClock();
  const fake = fakeClient({ register: { heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS } });
  const diagnostics: Record<string, unknown>[] = [];
  const worker = workerFor(fake, () => undefined, { count: 0 }, { clock, diagnostics });
  await worker.start();
  const pending = (worker as unknown as { pendingSettlements: Map<string, unknown> }).pendingSettlements;
  const settle = (worker as unknown as { settle: (e: Record<string, unknown>) => Promise<string> }).settle.bind(worker);
  const outcome = await settle({
    sessionId: "s",
    runId: "run_gone",
    claimToken: "t",
    operation: "failTurn",
    send: async () => {
      throw new EngineClientError("not_found", "no such turn", 404, { operation: "failTurn" });
    },
  });
  // An explicit disposition from the engine, not a failed retry.
  expect(outcome).toBe("settled");
  expect(pending.size).toBe(0);
  expect(diagnostics.some((line) => line.event === "turn_settlement_vacated")).toBeTrue();
  await worker.stop();
});
