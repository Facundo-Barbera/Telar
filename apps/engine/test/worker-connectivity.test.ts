import { expect, test } from "bun:test";
import { EngineClientError, sanitizeTransportCause } from "@telar/engine-client";
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
};

function fakeClient(options: { register?: { heartbeatIntervalMs?: number } | undefined } = {}): Fake {
  let failWith: unknown;
  let failFor = 0;
  const state: Fake = {
    heartbeats: 0,
    failed: [],
    fail: (error, times) => {
      failWith = error;
      failFor = times;
    },
    client: {
      registerWorker: async () => ({ worker: { workerId: "worker_fake" }, ...(options.register ?? {}) }),
      workerHeartbeat: async () => {
        state.heartbeats += 1;
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

/** A worker with a driver that is never reached — `dispose` is the observable. */
function workerFor(fake: Fake, onConnectionLost: () => void, disposed: { count: number }) {
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
  const fake = fakeClient({ register: { heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS } });
  let lost = 0;
  const disposed = { count: 0 };
  const worker = workerFor(fake, () => void (lost += 1), disposed);
  await worker.start();

  fake.fail(unreachable(), 10);
  await worker.tick();
  expect(lost).toBe(0);
  // Past the lease the engine may already have given this worker's work away,
  // so continuing would be acting outside it.
  await Bun.sleep(LEASE_MS + 20);
  await worker.tick();
  expect(lost).toBe(1);
  await worker.stop();
});

test("an intermittent connection never accumulates its way to a false loss", async () => {
  const fake = fakeClient({ register: { heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS } });
  let lost = 0;
  const worker = workerFor(fake, () => void (lost += 1), { count: 0 });
  await worker.start();
  // Fail, succeed, fail, succeed… across more than a lease of wall-clock. The
  // budget restarts on every answer, so no run of failures ever reaches it.
  for (let round = 0; round < 6; round += 1) {
    fake.fail(unreachable(), 1);
    await worker.tick();
    await worker.tick();
    await Bun.sleep(HEARTBEAT_INTERVAL_MS);
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
  expect(fake.failed[0]?.message).toContain("lost contact with its own engine");
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
