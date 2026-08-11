import crypto from "node:crypto";
import path from "node:path";
import { connectEngine } from "@telar/engine-client";
import { createClaudeDriver } from "./driver";
import { vnextRootFromEnv } from "./state";
import { EngineWorker } from "./worker";
import { WorkerReconnectController } from "./worker-supervisor";

const root = vnextRootFromEnv();
const workerId = process.env.TELAR_VNEXT_WORKER_ID?.trim() || `worker_vnext_${process.pid}_${crypto.randomUUID().replaceAll("-", "")}`;

if (!/^[A-Za-z0-9_-]+$/.test(workerId)) {
  throw new Error("TELAR_VNEXT_WORKER_ID must contain only letters, numbers, underscores, or hyphens");
}

let stopping = false;

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const supervisor = new WorkerReconnectController({
  connect: () => connectEngine(path.resolve(root)),
  createWorker: (client, onConnectionLost) => new EngineWorker({ client, workerId, driver: createClaudeDriver(), onConnectionLost }),
  pause,
});

await supervisor.start();
process.stdout.write(`Telar vNext worker ${workerId} registered\n`);

const stop = async (exitCode: number) => {
  if (stopping) return;
  stopping = true;
  await supervisor.stop();
  process.exit(exitCode);
};

process.once("SIGINT", () => void stop(0));
process.once("SIGTERM", () => void stop(0));
