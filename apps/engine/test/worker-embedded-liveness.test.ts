import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClientError } from "@telar/engine-client";
import type { TurnDriver } from "../src/driver";
import { EngineWorker } from "../src/worker";
import { createWorkerDiagnostics, sanitizeDiagnostic } from "../src/worker-diagnostics";

/**
 * #208 follow-up — THE WORKER MUST NOT EXPIRE ITSELF ON A CLOCK THE ENGINE DOES
 * NOT HOLD IT TO, and its evidence must survive stderr being /dev/null.
 *
 * Fakes and temp directories only: no daemon, no port, no engine home, no
 * installed app, no provider.
 */

const idle = { cancel: [], resolved: [], steer: [], stopTask: [] };
/** The daemon's own answer for a 15s lease: max(50, 15000/3). */
const HEARTBEAT_INTERVAL_MS = 5_000;

function fakeClock() {
  let at = 1_000_000;
  return { now: () => at, advance: (ms: number) => void (at += ms) };
}

function fakeClient() {
  let failWith: unknown;
  let failFor = 0;
  const state = {
    heartbeats: 0,
    fail: (error: unknown, times: number) => {
      failWith = error;
      failFor = times;
    },
    client: {
      registerWorker: async () => ({ worker: { workerId: "worker_embedded" }, heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS }),
      workerHeartbeat: async () => {
        state.heartbeats += 1;
        if (failFor > 0) {
          failFor -= 1;
          throw failWith;
        }
        return idle;
      },
      claimTurn: async () => ({}),
      failTurn: async () => undefined,
    } as Record<string, unknown>,
  };
  return state;
}

const driver: TurnDriver = { run: async () => ({ text: "" }) };
const unreachable = () =>
  new EngineClientError("engine_unavailable", "engine is unreachable", undefined, { operation: "workerHeartbeat", transport: "TypeError:ECONNRESET" });

function embedded(fake: ReturnType<typeof fakeClient>, clock: ReturnType<typeof fakeClock>, lost: { count: number }, diagnostics: Record<string, unknown>[] = []) {
  return new EngineWorker({
    client: fake.client as never,
    workerId: "worker_embedded",
    driver,
    pollMs: 60_000,
    leaseExempt: true,
    now: clock.now,
    pause: async () => {},
    onConnectionLost: () => void (lost.count += 1),
    onDiagnostic: (fields) => void diagnostics.push(fields),
  });
}

test("a 15-minute clock gap with NO transport failure leaves the embedded worker alive", async () => {
  /**
   * THE DEFECT. `daemon.ts` excludes the embedded registration from pruning, so
   * the engine holds it indefinitely — but the worker still expired itself on
   * `Date.now() - lastAckAt`. A laptop sleeping, or an event-loop stall, jumps
   * that clock past any lease with not one request having failed, and the
   * worker killed every healthy session in response to nothing.
   */
  const clock = fakeClock();
  const fake = fakeClient();
  const lost = { count: 0 };
  const worker = embedded(fake, clock, lost);
  await worker.start();
  // Far past the 15s lease this engine states, with the engine answering
  // perfectly throughout.
  clock.advance(15 * 60_000);
  await worker.tick();
  await Bun.sleep(HEARTBEAT_INTERVAL_MS / 2 + 40);
  expect(lost.count).toBe(0);
  expect(fake.heartbeats).toBe(2);
  await worker.stop();
});

test("suspension and resume do not manufacture failures", async () => {
  // No attempts happen while suspended, so nothing accrues: at most the one
  // in-flight request can fail, and a single failure is never a loss.
  const clock = fakeClock();
  const fake = fakeClient();
  const lost = { count: 0 };
  const worker = embedded(fake, clock, lost);
  await worker.start();
  for (let round = 0; round < 4; round += 1) {
    clock.advance(60 * 60_000);
    fake.fail(unreachable(), 1);
    await worker.tick();
    await worker.tick();
  }
  expect(lost.count).toBe(0);
  await worker.stop();
});

test("a genuine outage still loses the connection, counted in ATTEMPTS", async () => {
  const clock = fakeClock();
  const fake = fakeClient();
  const lost = { count: 0 };
  const diagnostics: Record<string, unknown>[] = [];
  const worker = embedded(fake, clock, lost, diagnostics);
  await worker.start();
  fake.fail(unreachable(), 10);
  for (let attempt = 0; attempt < 4; attempt += 1) await worker.tick();
  // Four consecutive failures is not yet a loss…
  expect(lost.count).toBe(0);
  await worker.tick();
  // …the fifth is.
  expect(lost.count).toBe(1);
  expect(diagnostics.some((line) => line.event === "connection_lost")).toBeTrue();
  await worker.stop();
});

test("a newer success clears the count, and a stale failure cannot override it", async () => {
  const clock = fakeClock();
  const fake = fakeClient();
  const lost = { count: 0 };
  const worker = embedded(fake, clock, lost);
  await worker.start();
  fake.fail(unreachable(), 4);
  for (let attempt = 0; attempt < 4; attempt += 1) await worker.tick();
  expect(lost.count).toBe(0);
  // One success resets the budget entirely.
  await worker.tick();
  fake.fail(unreachable(), 4);
  for (let attempt = 0; attempt < 4; attempt += 1) await worker.tick();
  expect(lost.count).toBe(0);

  // A failure whose ATTEMPT predates the last acknowledgement is stale and is
  // dropped — otherwise a slow request issued before a newer success could
  // push a worker that has already proved itself healthy toward a loss.
  const stale = (worker as unknown as { noteConnectivityFailure: (e: unknown, at?: number) => void }).noteConnectivityFailure.bind(worker);
  const before = (worker as unknown as { heartbeatFailures: number }).heartbeatFailures;
  stale(unreachable(), clock.now() - 10 * 60_000);
  expect((worker as unknown as { heartbeatFailures: number }).heartbeatFailures).toBe(before);
  await worker.stop();
});

test("revocation is still immediate for an exempt worker", async () => {
  for (const code of ["engine_unauthorized", "worker_unavailable"] as const) {
    const clock = fakeClock();
    const fake = fakeClient();
    const lost = { count: 0 };
    const worker = embedded(fake, clock, lost);
    await worker.start();
    fake.fail(new EngineClientError(code, "refused", 401, { operation: "workerHeartbeat" }), 1);
    await worker.tick();
    expect(lost.count).toBe(1);
    await worker.stop();
  }
});

test("exemption bounds requests; it does not license a hung one", async () => {
  // Exemption is from EXPIRY, never from bounding a call: the heartbeat still
  // carries a signal, so a hung engine cannot pin the loop.
  const clock = fakeClock();
  const fake = fakeClient();
  let sawSignal: AbortSignal | undefined;
  fake.client.workerHeartbeat = async (_id: string, signal?: AbortSignal) => {
    sawSignal = signal;
    return idle;
  };
  const worker = embedded(fake, clock, { count: 0 });
  await worker.start();
  expect(sawSignal).toBeInstanceOf(AbortSignal);
  await worker.stop();
});

test("diagnostics persist when stderr is discarded, stay bounded, and carry no secret", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-diag-"));
  try {
    const clock = fakeClock();
    const write = createWorkerDiagnostics(home, "worker_embedded", clock.now);
    write({ event: "engine_unreachable", operation: "workerHeartbeat", code: "engine_unavailable", transport: "TypeError:ECONNRESET" });
    write({ event: "connection_lost", operation: "workerHeartbeat", code: "engine_unavailable", status: 503, outageMs: 1234 });
    const file = path.join(home, "diagnostics", "worker.jsonl");
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ workerId: "worker_embedded", event: "engine_unreachable", transport: "TypeError:ECONNRESET" });
    expect(typeof lines[0].at).toBe("string");

    // A field that somehow arrived long, or carrying an authenticated URL, is
    // capped at the SINK — this layer copies only what it names.
    const secret = `http://127.0.0.1:8317/v2/workers/w/heartbeat?token=${"sk-secret".repeat(40)}`;
    const record = sanitizeDiagnostic("worker_embedded", "now", { event: "engine_unreachable", transport: secret } as never);
    expect(String(record.transport).length).toBeLessThanOrEqual(96);
    expect(Object.keys(record).sort()).toEqual(["at", "event", "transport", "workerId"]);
    // An unnamed field cannot cross at all.
    expect(sanitizeDiagnostic("w", "now", { event: "e", url: secret } as never).url).toBeUndefined();

    // Bounded: rotation keeps at most one previous generation.
    for (let round = 0; round < 12_000; round += 1) write({ event: "engine_unreachable", operation: "workerHeartbeat", code: "engine_unavailable", transport: "TypeError:ECONNRESET" });
    const entries = fs.readdirSync(path.join(home, "diagnostics")).sort();
    expect(entries).toEqual(["worker.jsonl", "worker.jsonl.1"]);
    const total = entries.reduce((sum, name) => sum + fs.statSync(path.join(home, "diagnostics", name)).size, 0);
    expect(total).toBeLessThanOrEqual(2 * 1_048_576);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a diagnostic sink that cannot write never destabilises the worker", () => {
  // The directory path is a FILE, so every mkdir and append fails.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-diag-bad-"));
  try {
    fs.writeFileSync(path.join(home, "diagnostics"), "not a directory");
    const write = createWorkerDiagnostics(home, "worker_embedded");
    expect(() => write({ event: "connection_lost" })).not.toThrow();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
