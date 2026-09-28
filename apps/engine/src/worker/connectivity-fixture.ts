import { EngineClientError } from "@telar/engine-client";
import type { TurnDriver } from "../drivers";
import { EngineWorker } from ".";

/** A heartbeat reply with nothing to deliver. */
export const idle = { cancel: [], resolved: [], steer: [], stopTask: [] };

/** The daemon prunes a worker after three missed intervals; 30ms keeps that contract, scaled for a test. */
export const HEARTBEAT_INTERVAL_MS = 30;
export const LEASE_MS = HEARTBEAT_INTERVAL_MS * 3;

type Fake = {
  client: Record<string, unknown>;
  heartbeats: number;
  failed: { code: string; message: string }[];
  /** Set to make the next N heartbeats reject with this error. */
  fail: (error: unknown, times: number) => void;
  /** Make heartbeats never resolve at all. */
  hang: (on: boolean) => void;
};

export function fakeClient(options: { register?: { heartbeatIntervalMs?: number } | undefined } = {}): Fake {
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
      registerWorker: async () => ({ worker: { workerId: "worker_fake" }, ...options.register }),
      workerHeartbeat: async () => {
        state.heartbeats += 1;
        // A request that never resolves.
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

export const unreachable = () => new EngineClientError("engine_unavailable", "engine is unreachable", undefined, { operation: "workerHeartbeat", transport: "TypeError:ECONNRESET" });

/** A clock the test moves by hand: the lease is a duration, and waiting it out
 *  in wall-clock makes a suite slow and load-sensitive for no added coverage. */
export function fakeClock() {
  let at = 1_000_000;
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

/** A worker with a driver that is never reached — `dispose` is the observable. */
export function workerFor(
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
    // Captured rather than printed to stderr.
    onDiagnostic: (fields) => void (extras.diagnostics ?? []).push(fields),
  });
}
