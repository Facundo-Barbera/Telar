// The panel's held count: peer notifications waiting for a session's next turn.
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../src/daemon";
import { stubModels } from "./stub-models";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-window-http-"));
  roots.push(directory);
  return directory;
};
afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

/** A coordinator, a worker, and a live claim on the worker — the proof an agent
 *  message is attributed from. */
async function ready() {
  const daemon = await startEngine({ models: stubModels, engineRoot: root() });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: root() });
  await client.createSession({ id: "session_coord", projectId: "project_one" });
  await client.createSession({ id: "session_worker", projectId: "project_one" });
  const store = daemon.store;
  store.submitTurn("session_worker", { runId: "run_source", input: "work" });
  const claimToken = store.claimTurn("session_worker", "worker_one")!.claim!.token;
  store.markRunning("session_worker", "run_source", claimToken);
  return { client, store, proof: { sessionId: "session_worker", runId: "run_source", claimToken } };
}

const report = (store: EngineDaemon["store"], proof: Parameters<EngineDaemon["store"]["submitAgentTurn"]>[2], runId: string) =>
  store.submitAgentTurn("session_coord", { runId, input: "progress", intent: "report" }, proof);

test("the route counts what is waiting for the next turn", async () => {
  const { client, store, proof } = await ready();
  expect(await client.sessionReportWindow("session_coord")).toEqual({ held: 0 });
  report(store, proof, "run_one");
  report(store, proof, "run_two");
  expect(await client.sessionReportWindow("session_coord")).toEqual({ held: 2 });
});
