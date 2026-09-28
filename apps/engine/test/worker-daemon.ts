import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient } from "@telar/engine-client";
import type { BrowserToolSocket } from "../src/domains/browser";
import { startEngine, type EngineDaemon } from "../src/daemon";
import type { TurnDriver } from "../src/drivers";
import { EngineWorker } from "../src/worker";
import { stubModels } from "./stub-models";

const roots: string[] = [];
export const daemons: EngineDaemon[] = [];
export const workers: EngineWorker[] = [];

/** A temp engine home with a known Claude default, so a claim is not withheld waiting for a model list. */
export const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-worker-"));
  roots.push(directory);
  fs.writeFileSync(path.join(directory, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  return directory;
};

/** Stops tracked workers and daemons and removes their homes; pass to `afterEach`. */
export async function teardown(): Promise<void> {
  for (const worker of workers.splice(0).reverse()) await worker.stop();
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
}

export async function setup(
  driver: TurnDriver,
  extras: { browserSocket?: BrowserToolSocket; workerLeaseMs?: number } = {},
): Promise<{ client: EngineClient; sessionId: string; worker: EngineWorker }> {
  // Manual ticks need a lease covering the test; expiry is tested separately.
  const daemon = await startEngine({ models: stubModels, engineRoot: root(), workerLeaseMs: extras.workerLeaseMs ?? 60_000 });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  const project = await client.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  const session = await client.createSession({ id: "session_one", projectId: project.project.id });
  const worker = new EngineWorker({ client, workerId: "worker_one", driver, ...(extras.browserSocket ? { browserSocket: extras.browserSocket } : {}), pollMs: 60_000 });
  workers.push(worker);
  await worker.start();
  return { client, sessionId: session.session.id, worker };
}
