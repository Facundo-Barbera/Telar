import crypto from "node:crypto";
import path from "node:path";
import { connectEngine } from "@telar/engine-client/node";
import { BrowserRuntime } from "./browser";
import { createBrowserToolSocket, createDefaultDrivers } from "./drivers";
import { hydrateHostPath } from "./host-path";
import { SessionsToolSocket } from "./sessions-tools/run-socket";
import { PluginToolSocket } from "./plugins/socket";
import { TelarToolSocket } from "./telar-socket";
import { createLoginGrantStore } from "./secrets/login-grants";
import { engineRootFromEnv, statePaths } from "./state";
import { EngineWorker, workerConcurrencyFromEnv } from "./worker";
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
// The sessions wall for Codex turns, served from the same place and for the
// same reason: the tools live where the worker's client is.
const sessionsSocket = new SessionsToolSocket();
// The plugin walls, served from the same place — and for BOTH providers, since
// a plugin tool has no in-process registration on either. See `plugins/socket.ts`.
const pluginSocket = new PluginToolSocket();
// The `telar` wall for Codex turns — the core toolkits plus the migrated ones,
// under the key they already ship under. See `telar-socket.ts`.
const telarSocket = new TelarToolSocket();
/**
 * Remembered login authorizations live in the ENGINE'S STATE DIRECTORY, not in
 * either process, so the daemon (which lists and revokes them in settings) and
 * whichever worker runs a turn read exactly one truth. Nothing is cached on
 * either side — see `createLoginGrantStore`.
 */
const loginGrants = createLoginGrantStore(statePaths(root).root);

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
// The SAME factory the daemon's embedded worker uses. Both deployments must
// offer the same providers with the same capabilities, or which one started the
// engine changes what a session can do.
const drivers = createDefaultDrivers();
const supervisor = new WorkerReconnectController({
  connect: () => connectEngine(path.resolve(root)),
  createWorker: (client, onConnectionLost) => {
    const concurrency = workerConcurrencyFromEnv();
    return new EngineWorker({
      client,
      workerId,
      driver: drivers,
      browserSocket,
      sessionsSocket,
      pluginSocket,
      telarSocket,
      loginGrants,
      ...(concurrency === undefined ? {} : { concurrency }),
      onConnectionLost,
    });
  },
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
  await sessionsSocket.close();
  await browser.close("worker shutting down");
  process.exit(exitCode);
};

process.once("SIGINT", () => void stop(0));
process.once("SIGTERM", () => void stop(0));
