import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient, EngineClientError, sanitizeTransportCause } from "@telar/engine-client";
import { startEngine } from "../src/daemon";
import type { TurnDriver } from "../src/driver";
import { EngineWorker } from "../src/worker";
import { WorkerReconnectController, type SupervisedWorker } from "../src/worker-supervisor";

/**
 * #208 — A TRANSIENT LOOPBACK FAILURE IS NOT A SHUTDOWN.
 *
 * Everything here runs against a FAKE CLIENT: no daemon, no port, no engine
 * home, no temp directory, no provider. The fault is injected into the client's
 * own promise, which is the seam the incident actually travelled through.
 *
 * The behaviour being pinned, from the observed incident: the installed
 * daemon's PID never changed, and two worker generations died anyway. One
 * failed heartbeat aborted every active turn, made the supervisor replace the
 * worker, disposed the Claude driver (killing every session's background
 * shells and monitors), and settled each turn with copy asserting Telar had
 * shut down.
 */

/** A heartbeat reply with nothing to deliver. */
const idle = { cancel: [], resolved: [], steer: [], stopTask: [] };

/**
 * The daemon answers `registerWorker` with `heartbeatIntervalMs`, and prunes a
 * worker whose last heartbeat is older than three of them. 30ms here keeps a
 * 90ms lease — the same CONTRACT the daemon states, scaled for a test rather
 * than a threshold invented in the worker.
 */
const HEARTBEAT_INTERVAL_MS = 30;
const LEASE_MS = HEARTBEAT_INTERVAL_MS * 3;

type Fake = {
  client: Record<string, unknown>;
  heartbeats: number;
  failed: { code: string; message: string }[];
  /** Set to make the next N heartbeats reject with this error. */
  fail: (error: unknown, times: number) => void;
  /** Make heartbeats never resolve at all. */
  hang: (on: boolean) => void;
};

function fakeClient(options: { register?: { heartbeatIntervalMs?: number } | undefined } = {}): Fake {
  let failWith: unknown;
  let failFor = 0;
  let hang = false;
  const state: Fake = {
    heartbeats: 0,
    failed: [],
    fail: (error, times) => {
      failWith = error;
      failFor = times;
    },
    hang: (on) => {
      hang = on;
    },
    client: {
      registerWorker: async () => ({ worker: { workerId: "worker_fake" }, ...(options.register ?? {}) }),
      workerHeartbeat: async () => {
        state.heartbeats += 1;
        // A request that never resolves — the case that used to pin `ticking`
        // true forever so the budget was never evaluated at all.
        if (hang) return new Promise(() => {});
        if (failFor > 0) {
          failFor -= 1;
          throw failWith;
        }
        return idle;
      },
      // No turn is ever claimed in these tests: the fault is on the control
      // path, and claiming would pull in a provider this file has no business
      // exercising.
      claimTurn: async () => ({}),
      failTurn: async (_sessionId: string, _runId: string, _token: string, failure: { code: string; message: string }) => {
        state.failed.push(failure);
      },
    },
  };
  return state;
}

const unreachable = () => new EngineClientError("engine_unavailable", "engine is unreachable", undefined, { operation: "workerHeartbeat", transport: "TypeError:ECONNRESET" });

/** A clock the test moves by hand: the lease is a duration, and waiting it out
 *  in wall-clock makes a suite slow and load-sensitive for no added coverage. */
function fakeClock() {
  let at = 1_000_000;
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

/** A worker with a driver that is never reached — `dispose` is the observable. */
function workerFor(
  fake: Fake,
  onConnectionLost: () => void,
  disposed: { count: number },
  extras: { clock?: ReturnType<typeof fakeClock>; diagnostics?: Record<string, unknown>[] } = {},
) {
  const driver: TurnDriver = {
    run: async () => ({ text: "" }),
    dispose: () => {
      disposed.count += 1;
    },
  };
  return new EngineWorker({
    client: fake.client as never,
    workerId: "worker_fake",
    driver,
    // Long enough that only the ticks this test drives by hand ever happen.
    pollMs: 60_000,
    onConnectionLost,
    ...(extras.clock ? { now: extras.clock.now } : {}),
    // No real sleeping anywhere in this file.
    pause: async () => {},
    // Always captured rather than printed: the default sink is stderr, which
    // would make this suite's output unreadable.
    onDiagnostic: (fields) => void (extras.diagnostics ?? []).push(fields),
  });
}

test("one failed heartbeat does NOT lose the connection — the engine's lease is the budget", async () => {
  const fake = fakeClient({ register: { heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS } });
  let lost = 0;
  const disposed = { count: 0 };
  const worker = workerFor(fake, () => void (lost += 1), disposed);
  await worker.start();

  fake.fail(unreachable(), 1);
  await worker.tick();
  // Nothing was torn down: no supervisor notification, no driver disposal.
  expect(lost).toBe(0);
  expect(disposed.count).toBe(0);

  // …and the engine answering again clears the outage entirely.
  await worker.tick();
  fake.fail(unreachable(), 1);
  await worker.tick();
  expect(lost).toBe(0);
  await worker.stop();
});

test("an outage that outlasts the lease IS a real loss, and still stops safely", async () => {
  const clock = fakeClock();
  const fake = fakeClient({ register: { heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS } });
  let lost = 0;
  const disposed = { count: 0 };
  const worker = workerFor(fake, () => void (lost += 1), disposed, { clock });
  await worker.start();

  fake.fail(unreachable(), 10);
  await worker.tick();
  expect(lost).toBe(0);
  // Past the lease the engine may already have given this worker's work away,
  // so continuing would be acting outside it.
  clock.advance(LEASE_MS + 1);
  await worker.tick();
  expect(lost).toBe(1);
  await worker.stop();
});

test("the budget runs from the last ACK, so a late failure cannot open a fresh lease", async () => {
  /**
   * The defect this pins: anchoring on the first FAILED response. A request
   * issued at t=29s of a 30s lease and failing at t=31s would start counting
   * at t=31s, letting the worker act arbitrarily far past the engine's own
   * expiry. The anchor is the last acknowledged exchange, taken at the moment
   * it was ISSUED so response latency counts against us, never for us.
   */
  const clock = fakeClock();
  const fake = fakeClient({ register: { heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS } });
  let lost = 0;
  const worker = workerFor(fake, () => void (lost += 1), { count: 0 }, { clock });
  await worker.start();
  // Almost the whole lease passes with no exchange at all…
  clock.advance(LEASE_MS - 1);
  fake.fail(unreachable(), 5);
  // …and the first failure lands just inside it: still tolerated, but it does
  // NOT reset anything.
  await worker.tick();
  expect(lost).toBe(0);
  clock.advance(2);
  await worker.tick();
  expect(lost).toBe(1);
  await worker.stop();
});

test("a heartbeat that never resolves still expires — the watchdog does not wait for it", async () => {
  /**
   * A hung request held `ticking` true forever, so every later tick
   * early-returned and the budget was never evaluated: the worker would sit
   * past the engine's lease indefinitely. The deadline is now checked on a
   * timer of its own.
   */
  const clock = fakeClock();
  const fake = fakeClient({ register: { heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS } });
  let lost = 0;
  const worker = workerFor(fake, () => void (lost += 1), { count: 0 }, { clock });
  await worker.start();
  fake.hang(true);
  void worker.tick();
  await Bun.sleep(5);
  // The tick is parked forever; only the clock moves.
  expect(lost).toBe(0);
  clock.advance(LEASE_MS + 1);
  // Only the watchdog can notice: it runs on its own timer, at about the
  // heartbeat interval, while the tick stays parked.
  await Bun.sleep(LEASE_MS + 40);
  expect(lost).toBe(1);
  await worker.stop();
});

test("a reply arriving after the lease expired changes nothing", async () => {
  // A late success must not resurrect a worker the supervisor is already
  // replacing, nor re-anchor a budget that is already spent.
  const clock = fakeClock();
  const fake = fakeClient({ register: { heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS } });
  let lost = 0;
  const worker = workerFor(fake, () => void (lost += 1), { count: 0 }, { clock });
  await worker.start();
  fake.fail(unreachable(), 1);
  clock.advance(LEASE_MS + 1);
  await worker.tick();
  expect(lost).toBe(1);
  // The engine comes back. The loss has already been reported exactly once and
  // is not retracted or repeated.
  await worker.tick();
  expect(lost).toBe(1);
  await worker.stop();
});

test("an intermittent connection never accumulates its way to a false loss", async () => {
  const clock = fakeClock();
  const fake = fakeClient({ register: { heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS } });
  let lost = 0;
  const worker = workerFor(fake, () => void (lost += 1), { count: 0 }, { clock });
  await worker.start();
  // Fail, succeed, fail, succeed… across more than a lease of wall-clock. The
  // budget restarts on every answer, so no run of failures ever reaches it.
  for (let round = 0; round < 6; round += 1) {
    fake.fail(unreachable(), 1);
    await worker.tick();
    await worker.tick();
    clock.advance(HEARTBEAT_INTERVAL_MS);
  }
  expect(lost).toBe(0);
  await worker.stop();
});

test("a REVOKED registration or credential is immediate — there is nothing to wait out", async () => {
  for (const code of ["engine_unauthorized", "worker_unavailable"] as const) {
    const fake = fakeClient({ register: { heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS } });
    let lost = 0;
    const worker = workerFor(fake, () => void (lost += 1), { count: 0 });
    await worker.start();
    fake.fail(new EngineClientError(code, "refused", 503, { operation: "workerHeartbeat" }), 1);
    await worker.tick();
    // The ENGINE answered, definitively, that this worker may not act. Riding
    // that out would be work outside the lease.
    expect(lost).toBe(1);
    await worker.stop();
  }
});

test("an engine that states no lease fails closed on the first failure, as before #208", async () => {
  // Guessing a budget against an engine whose expiry rule we do not know would
  // be inventing exactly the threshold the lease exists to avoid.
  const fake = fakeClient({ register: undefined });
  let lost = 0;
  const worker = workerFor(fake, () => void (lost += 1), { count: 0 });
  await worker.start();
  fake.fail(unreachable(), 1);
  await worker.tick();
  expect(lost).toBe(1);
  await worker.stop();
});

test("a replaced worker's turns are told they were REPLACED, not that Telar shut down", async () => {
  const fake = fakeClient({ register: { heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS } });
  const worker = workerFor(fake, () => undefined, { count: 0 });
  await worker.start();
  // A turn this worker is running, reached through the same path a real
  // interruption takes.
  const active = (worker as unknown as { active: Map<string, AbortController> }).active;
  active.set("claim_one", new AbortController());
  const inFlight = (worker as unknown as { inFlight: Set<Promise<void>> }).inFlight;
  const settle = (async () => {
    await Bun.sleep(5);
    await (worker as unknown as { recordInterruption: (s: string, r: string, t: string) => Promise<void> }).recordInterruption("session_one", "run_one", "claim_one");
  })();
  inFlight.add(settle);

  await worker.stop("connection_lost");
  await settle;
  expect(fake.failed).toHaveLength(1);
  expect(fake.failed[0]?.code).toBe("interrupted");
  // The copy is the whole point: asserting a shutdown that did not happen is
  // both false and undebuggable.
  expect(fake.failed[0]?.message).not.toContain("Telar shut down");
  expect(fake.failed[0]?.message).toContain("lost contact with the engine and was replaced");
  // NEUTRAL ABOUT CAUSE: a replacement can follow an expired budget, a refused
  // credential OR an unknown registration, and an immediate `engine_unauthorized`
  // exceeded no duration. The copy must not assert one of them.
  expect(fake.failed[0]?.message).not.toContain("longer than");
  expect(fake.failed[0]?.message).not.toContain("allows");
  // What it had already done is still claimed as retained, and what is unknown
  // is still stated as unknown.
  expect(fake.failed[0]?.message).toContain("whether it had finished anything elsewhere is unknown");
});

test("an actual shutdown still says so", async () => {
  const fake = fakeClient({ register: { heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS } });
  const worker = workerFor(fake, () => undefined, { count: 0 });
  await worker.start();
  await worker.stop();
  await (worker as unknown as { recordInterruption: (s: string, r: string, t: string) => Promise<void> }).recordInterruption("session_one", "run_one", "claim_one");
  expect(fake.failed[0]?.message).toContain("Telar shut down");
});

test("shutdown wins over a recovery already in flight, and no two reconnects overlap", async () => {
  /**
   * A quit landing mid-recovery must not publish a worker nobody asked for,
   * and a burst of connection-loss reports must not start a second connect
   * loop beside the first.
   */
  let building = 0;
  let started = 0;
  const stops: (string | undefined)[] = [];
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const controller = new WorkerReconnectController<{}, SupervisedWorker>({
    connect: async () => ({}),
    createWorker: async (_client, onConnectionLost) => {
      building += 1;
      if (building === 1) {
        // Three losses reported at once: one reconnect, not three.
        queueMicrotask(() => {
          onConnectionLost();
          onConnectionLost();
          onConnectionLost();
        });
      }
      if (building === 2) await held;
      return {
        async start() {
          started += 1;
        },
        async stop(reason) {
          stops.push(reason);
        },
      };
    },
    pause: async () => {},
  });

  // NOT awaited: the second candidate is parked inside `createWorker`, so the
  // connect loop is still running — which is exactly the window a quit has to
  // win in.
  const starting = controller.start();
  await Bun.sleep(10);
  const quitting = controller.stop();
  release!();
  await Promise.all([starting, quitting]);

  // The second candidate was built while stopping and never published.
  expect(building).toBe(2);
  expect(started).toBeLessThanOrEqual(1);
  // A replacement is named a replacement; the quit is named a shutdown.
  expect(stops).toContain("connection_lost");
  expect(stops.filter((reason) => reason === "connection_lost")).toHaveLength(1);
});

test("the transport cause is retained, and carries no URL or credential", () => {
  /**
   * The client used to catch the fetch rejection and throw it away, which is
   * why the incident cannot be attributed even now. The raw error is still not
   * propagated: its message and cause chain carry the loopback URL, and those
   * URLs are authenticated with the engine's bearer token.
   */
  const secret = "http://127.0.0.1:8317/v2/workers/w/heartbeat?token=sk-secret";
  const cause = Object.assign(new TypeError(`fetch failed: ${secret}`), {
    cause: Object.assign(new Error(secret), { code: "ECONNRESET" }),
  });
  expect(sanitizeTransportCause(cause)).toBe("TypeError:ECONNRESET");
  expect(sanitizeTransportCause(cause)).not.toContain("127.0.0.1");
  expect(sanitizeTransportCause(cause)).not.toContain("sk-secret");

  // An arbitrary string on `code` is not errno-shaped and is refused.
  expect(sanitizeTransportCause(Object.assign(new Error("x"), { code: secret }))).toBe("Error");
  // Nothing to say stays honestly absent rather than becoming a guess.
  expect(sanitizeTransportCause(undefined)).toBeUndefined();
  expect(sanitizeTransportCause("a bare string")).toBeUndefined();
  // A cause cycle terminates.
  const loop: { name: string; cause?: unknown } = { name: "Err" };
  loop.cause = loop;
  expect(sanitizeTransportCause(loop)).toBe("Err");

  // And the error keeps which call failed, so a supervisor can tell an
  // idempotent poll from a mutating submission without parsing a URL.
  const error = new EngineClientError("engine_unavailable", "engine is unreachable", undefined, { operation: "workerHeartbeat", transport: "TypeError:ECONNRESET" });
  expect(error.operation).toBe("workerHeartbeat");
  expect(error.transport).toBe("TypeError:ECONNRESET");
  expect(JSON.stringify({ message: error.message, ...error })).not.toContain("sk-secret");
});

test("every connectivity outcome reaches the diagnostic sink, sanitized and bounded", async () => {
  /**
   * The fields are useless if nothing consumes them: before this the sanitized
   * cause was recorded on the error and then dropped exactly as the raw cause
   * had been, so the next failure would disappear the same way.
   */
  const clock = fakeClock();
  const fake = fakeClient({ register: { heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS } });
  const diagnostics: Record<string, unknown>[] = [];
  const worker = workerFor(fake, () => undefined, { count: 0 }, { clock, diagnostics });
  await worker.start();

  fake.fail(unreachable(), 3);
  await worker.tick();
  await worker.tick();
  await worker.tick();
  // ONE line per outage, not one per tick — a flapping engine must not be able
  // to fill a log.
  expect(diagnostics.filter((line) => line.event === "engine_unreachable")).toHaveLength(1);
  expect(diagnostics[0]).toEqual({ event: "engine_unreachable", code: "engine_unavailable", operation: "workerHeartbeat", transport: "TypeError:ECONNRESET" });

  // Recovery is recorded too, so an outage has a visible end.
  await worker.tick();
  expect(diagnostics.some((line) => line.event === "engine_reachable")).toBeTrue();

  // …and a terminal loss carries how long it lasted.
  fake.fail(unreachable(), 5);
  clock.advance(LEASE_MS + 1);
  await worker.tick();
  const terminal = diagnostics.find((line) => line.event === "connection_lost");
  expect(terminal).toMatchObject({ code: "engine_unavailable", transport: "lease_expired" });
  expect(typeof terminal?.outageMs).toBe("number");

  // Nothing anywhere carries the error's own message, a URL or a credential.
  // (`engine_unreachable` is this sink's event vocabulary, not the error text.)
  const dumped = JSON.stringify(diagnostics);
  expect(dumped).not.toContain("engine is unreachable");
  expect(dumped).not.toContain("127.0.0.1");
  expect(dumped).not.toContain("Bearer");
  await worker.stop();
});

test("a loss reported while the previous worker is still stopping starts ONE reconnect", async () => {
  /**
   * The window root found: `reconnect` awaits `previous.stop()` BEFORE
   * `connect()` sets `connecting`, so a second report landing inside that await
   * saw neither guard and started a rival connect loop.
   */
  let built = 0;
  let releaseStop: (() => void) | undefined;
  const stopping = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });
  let report: (() => void) | undefined;
  const controller = new WorkerReconnectController<{}, SupervisedWorker>({
    connect: async () => ({}),
    createWorker: async (_client, onConnectionLost) => {
      built += 1;
      const mine = built;
      report = onConnectionLost;
      return {
        async start() {},
        async stop() {
          // The first worker's stop parks, holding the window open.
          if (mine === 1) await stopping;
        },
      };
    },
    pause: async () => {},
  });
  await controller.start();
  expect(built).toBe(1);

  report!();
  await Bun.sleep(5);
  // A second and third report land while the first worker is still stopping.
  report!();
  report!();
  releaseStop!();
  await Bun.sleep(20);

  // Exactly one replacement was built, not three.
  expect(built).toBe(2);
  await controller.stop();
});

test("stop during registration installs no timers and claims nothing", async () => {
  // No timers, no claims, no work after stop() — whenever it lands.
  const fake = fakeClient({ register: { heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS } });
  let released: (() => void) | undefined;
  const registering = new Promise<void>((resolve) => {
    released = resolve;
  });
  fake.client.registerWorker = async () => {
    await registering;
    return { worker: { workerId: "worker_fake" }, heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS };
  };
  const worker = workerFor(fake, () => undefined, { count: 0 });
  const starting = worker.start();
  await worker.stop();
  released!();
  await starting;
  expect(fake.heartbeats).toBe(0);
  expect((worker as unknown as { timer?: unknown }).timer).toBeUndefined();
  expect((worker as unknown as { watchdog?: unknown }).watchdog).toBeUndefined();
});

test("stop during the initial heartbeat leaves no poll timer behind", async () => {
  const fake = fakeClient({ register: { heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS } });
  const worker = workerFor(fake, () => undefined, { count: 0 });
  const original = fake.client.workerHeartbeat as () => Promise<unknown>;
  fake.client.workerHeartbeat = async () => {
    // The stop lands inside the very first heartbeat.
    void worker.stop();
    return original();
  };
  await worker.start();
  expect((worker as unknown as { timer?: unknown }).timer).toBeUndefined();
  expect((worker as unknown as { watchdog?: unknown }).watchdog).toBeUndefined();
});

test("a reply that lands after the deadline but before the watchdog fires is refused", async () => {
  /**
   * The watchdog runs every lease/3, so an expired reply can arrive before it
   * next fires. Checking only the flags let that reply reset `lastAckAt` and
   * resurrect a budget already spent — so the absolute deadline is checked
   * before the acknowledgement is accepted.
   */
  const clock = fakeClock();
  const fake = fakeClient({ register: { heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS } });
  let lost = 0;
  const worker = workerFor(fake, () => void (lost += 1), { count: 0 }, { clock });
  await worker.start();
  // The heartbeat succeeds, but the whole lease elapses while it is in flight.
  const original = fake.client.workerHeartbeat as () => Promise<unknown>;
  fake.client.workerHeartbeat = async () => {
    clock.advance(LEASE_MS + 1);
    return original();
  };
  await worker.tick();
  expect(lost).toBe(1);
  await worker.stop();
});

test("a lost settlement response is retried as ITSELF, against the real engine store", async () => {
  /**
   * The mislabelling this pins: a completed turn whose `completeTurn` response
   * was lost used to be re-reported as `interrupted`, which is a different
   * outcome, not a retry of this one. Runs against an actual daemon and store
   * in a temp home — the wrapper drops the RESPONSE, so the first write really
   * does commit and the retry really does meet the engine's own conflict.
   */
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-settle-"));
  const daemon = await startEngine({ engineRoot: home, workerLeaseMs: 5_000 });
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
    const worker = new EngineWorker({
      client,
      workerId: "worker_settle",
      driver: { run: async () => ({ text: "the answer", usage: { tokens: { input: 5, output: 7, cacheRead: 0, cacheCreate: 0 } } }) },
      pollMs: 60_000,
      pause: async () => {},
      onDiagnostic: (fields) => void diagnostics.push(fields),
    });
    await worker.start();
    await client.submitTurn(session.session.id, { runId: "run_one", input: "Hello" });
    await worker.tick();

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

test("a settlement refused by revocation fails closed at once, and never spins", async () => {
  // Revocation is the engine's verdict on this worker: there is nothing to
  // retry, and the old loop kept going without even reporting the loss.
  const clock = fakeClock();
  const fake = fakeClient({ register: { heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS } });
  let attempts = 0;
  let lost = 0;
  fake.client.failTurn = async () => {
    attempts += 1;
    throw new EngineClientError("worker_unavailable", "unknown worker", 503, { operation: "failTurn" });
  };
  const diagnostics: Record<string, unknown>[] = [];
  const worker = workerFor(fake, () => void (lost += 1), { count: 0 }, { clock, diagnostics });
  await worker.start();
  const settle = (worker as unknown as { settle: (op: string, send: () => Promise<unknown>) => Promise<string> }).settle.bind(worker);
  const outcome = await settle("failTurn", () => (fake.client.failTurn as () => Promise<unknown>)());
  expect(attempts).toBe(1);
  expect(outcome).toBe("uncertain");
  expect(lost).toBe(1);
  expect(diagnostics.some((line) => line.event === "turn_unsettled" && line.code === "worker_unavailable")).toBeTrue();
  await worker.stop();
});

test("a settlement endpoint that keeps failing is bounded per turn and spares healthy sessions", async () => {
  /**
   * An endpoint failing while heartbeats succeed is not evidence the engine is
   * gone. Exhaustion records the turn as uncertain; it must not take the
   * connection — and with it every other session's work — down with it.
   */
  const clock = fakeClock();
  const fake = fakeClient({ register: { heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS } });
  let attempts = 0;
  let lost = 0;
  fake.client.failTurn = async () => {
    attempts += 1;
    throw new EngineClientError("engine_unavailable", "engine is unreachable", undefined, { operation: "failTurn", transport: "TypeError:ECONNRESET" });
  };
  const diagnostics: Record<string, unknown>[] = [];
  const worker = workerFor(fake, () => void (lost += 1), { count: 0 }, { clock, diagnostics });
  await worker.start();
  const settle = (worker as unknown as { settle: (op: string, send: () => Promise<unknown>) => Promise<string> }).settle.bind(worker);
  expect(await settle("failTurn", () => (fake.client.failTurn as () => Promise<unknown>)())).toBe("uncertain");
  // Bounded, and the connection survives: heartbeats are still answering.
  expect(attempts).toBe(5);
  expect(lost).toBe(0);
  expect(diagnostics.some((line) => line.event === "turn_unsettled")).toBeTrue();
  await worker.stop();
});
