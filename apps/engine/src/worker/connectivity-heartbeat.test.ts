import { expect, test } from "bun:test";
import { EngineClientError, sanitizeTransportCause } from "@telar/engine-client";
import { fakeClient, fakeClock, HEARTBEAT_INTERVAL_MS, LEASE_MS, unreachable, workerFor } from "./connectivity-fixture";

test("one failed heartbeat does NOT lose the connection — the engine's lease is the budget", async () => {
  const fake = fakeClient({ register: { heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS } });
  let lost = 0;
  const disposed = { count: 0 };
  const worker = workerFor(fake, () => void (lost += 1), disposed, { clock: fakeClock() });
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
  // The anchor is the last acknowledged exchange, taken when it was issued, so
  // response latency counts against the worker, never for it.
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
  // The deadline is checked on a timer of its own, not by the parked tick.
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

test("the transport cause is retained, and carries no URL or credential", () => {
  // The raw error is never propagated: its message and cause chain carry the
  // loopback URL, which is authenticated with the engine's bearer token.
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
  const clock = fakeClock();
  const fake = fakeClient({ register: { heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS } });
  const diagnostics: Record<string, unknown>[] = [];
  const worker = workerFor(fake, () => undefined, { count: 0 }, { clock, diagnostics });
  await worker.start();

  fake.fail(unreachable(), 3);
  await worker.tick();
  await worker.tick();
  await worker.tick();
  // One line per outage, not per tick, so a flapping engine cannot fill a log.
  expect(diagnostics.filter((line) => line.event === "engine_unreachable")).toHaveLength(1);
  expect(diagnostics[0]).toEqual({ event: "worker_registered", operation: "registerWorker" });
  expect(diagnostics.find(line => line.event === "engine_unreachable")).toEqual({ event: "engine_unreachable", code: "engine_unavailable", operation: "workerHeartbeat", transport: "TypeError:ECONNRESET" });

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
  // The watchdog runs every lease/3, so the absolute deadline is checked
  // before an acknowledgement is accepted.
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
