import crypto from "node:crypto";
import path from "node:path";
import { connectEngine } from "@telar/engine-client/node";
import { BrowserRuntime } from "./browser";
import { createBrowserToolSocket, createDefaultDrivers } from "./drivers";
import { hydrateHostPath } from "./host-path";
import { engineRootFromEnv } from "./state";
import { EngineWorker } from "./worker";
import { WorkerReconnectController } from "./worker-supervisor";

/**
 * THE WORKER IS THE PROCESS THAT SPAWNS PROVIDERS, so it needs the repaired
 * PATH at least as much as the daemon does. Harmless when it is a child of a
 * daemon that already did this — it inherits the merged value and merging it
 * again is a no-op — and load-bearing when it is not.
 */
hydrateHostPath();

const root = engineRootFromEnv();
const workerId = process.env.TELAR_WORKER_ID?.trim() || `worker_${process.pid}_${crypto.randomUUID().replaceAll("-", "")}`;

if (!/^[A-Za-z0-9_-]+$/.test(workerId)) {
  throw new Error("TELAR_WORKER_ID must contain only letters, numbers, underscores, or hyphens");
}

let stopping = false;

/**
 * THE OUT-OF-PROCESS WORKER OWNS ITS OWN BROWSER.
 *
 * The daemon builds one for its embedded worker, but a worker in its own
 * process cannot reach that instance — and without this it would run with no
 * browser tools at all, silently, while the embedded deployment had them. Two
 * deployments that differ in what the agent can DO is the kind of gap nobody
 * notices until a detached run behaves differently depending on how it was
 * started.
 *
 * One browser per worker process is correct rather than merely convenient:
 * scopes are per session, and a session is only ever claimed by one worker.
 * ONE SOCKET PER WORKER PROCESS for the same reason — and the socket is why a
 * worker in its own process can serve the browser at all: the daemon cannot
 * reach this runtime, so the tools are served from where it lives.
 */
const browser = new BrowserRuntime();
const browserSocket = createBrowserToolSocket(browser);

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
// The SAME factory the daemon's embedded worker uses. Both deployments must
// offer the same providers with the same capabilities, or which one started the
// engine changes what a session can do.
const drivers = createDefaultDrivers();
const supervisor = new WorkerReconnectController({
  connect: () => connectEngine(path.resolve(root)),
  createWorker: (client, onConnectionLost) => new EngineWorker({ client, workerId, driver: drivers, browserSocket, onConnectionLost }),
  pause,
});

await supervisor.start();
process.stdout.write(`Telar worker ${workerId} registered\n`);

const stop = async (exitCode: number) => {
  if (stopping) return;
  stopping = true;
  await supervisor.stop();
  // The socket before the browser it fronts, and both after the supervisor: a
  // live Chromium holding a profile lock outlives the process that spawned it
  // otherwise.
  await browserSocket.close();
  await browser.close("worker shutting down");
  process.exit(exitCode);
};

process.once("SIGINT", () => void stop(0));
process.once("SIGTERM", () => void stop(0));
