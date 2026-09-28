import { expect, test } from "bun:test";
import { WorkerReconnectController, type SupervisedWorker } from "./supervisor";
import { fakeClient, HEARTBEAT_INTERVAL_MS, workerFor } from "./connectivity-fixture";

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
  expect(fake.failed[0]?.message).not.toContain("Telar shut down");
  expect(fake.failed[0]?.message).toContain("lost contact with the engine and was replaced");
  // Neutral about cause: an expired budget, a refused credential or an unknown registration.
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

  // Not awaited: the second candidate is parked inside `createWorker`, the window a quit has to win in.
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

test("a loss reported while the previous worker is still stopping starts ONE reconnect", async () => {
  // `reconnect` awaits `previous.stop()` before `connect()` sets `connecting`.
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
