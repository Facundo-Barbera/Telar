import crypto from "node:crypto";
import path from "node:path";
import { registerPluginToolPrefixes } from "@telar/engine-client";
import { connectEngine } from "@telar/engine-client/node";
import { BrowserRuntime } from "../domains/browser";
import { createBrowserToolSocket, createDefaultDrivers } from "../drivers";
import { hydrateHostPath } from "../platform/process/host-path";
import { TelarToolSocket } from "../domains/agent-tools";
import { createLoginGrantStore } from "../domains/browser";
import { bundledPluginToolModules, externalPluginsDir, externalToolModule, loadInstalledPlugins, setPluginToolModules } from "../domains/plugins";
import { engineRootFromEnv } from "../state";
import { statePaths } from "../platform/fs/state-paths";
import { EngineWorker, workerConcurrencyFromEnv } from ".";
import { WorkerReconnectController } from "./supervisor";

hydrateHostPath();

const root = engineRootFromEnv();
const workerId = process.env.TELAR_WORKER_ID?.trim() || `worker_${process.pid}_${crypto.randomUUID().replaceAll("-", "")}`;

if (!/^[A-Za-z0-9_-]+$/.test(workerId)) {
  throw new Error("TELAR_WORKER_ID must contain only letters, numbers, underscores, or hyphens");
}

const loadPluginTools = () => {
  const installed = loadInstalledPlugins(externalPluginsDir(root)).loaded;
  registerPluginToolPrefixes(installed.flatMap((loaded) => (loaded.manifest.toolPrefix ? [loaded.manifest.toolPrefix] : [])));
  setPluginToolModules([...bundledPluginToolModules(), ...installed.map(externalToolModule)]);
};
loadPluginTools();

let stopping = false;

const browser = new BrowserRuntime();
const browserSocket = createBrowserToolSocket(browser);
const telarSocket = new TelarToolSocket();
const loginGrants = createLoginGrantStore(statePaths(root).root);

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
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
      telarSocket,
      loginGrants,
      refreshPlugins: loadPluginTools,
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
  await browserSocket.close();
  await telarSocket.close();
  await browser.close("worker shutting down");
  process.exit(exitCode);
};

process.once("SIGINT", () => void stop(0));
process.once("SIGTERM", () => void stop(0));
