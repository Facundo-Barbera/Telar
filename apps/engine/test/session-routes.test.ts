/**
 * THE SESSION-SCOPED ROUTE TABLE, EXERCISED ACROSS NEIGHBOURS.
 *
 * This file exists because of a specific failure mode, hit three times while
 * the plugin host was ported: an edit to ONE arm of the session router silently
 * removes or shadows the arm beside it, and every suite that tests those arms
 * in isolation still passes.
 *
 * So each case here touches an UNRELATED arm as well as the one it is about.
 * `submitTurn` is the canary — it is nobody's feature, it has nothing to do
 * with plugins or runs, and it is the arm that broke when the run door read the
 * request body for every session request. If a future edit eats a neighbour,
 * this goes red where the feature suites would not.
 *
 * Temp engine home per case. No provider process, no TeX, no kernel: every call
 * either succeeds structurally or is refused at a gate, which is where a machine
 * without those toolchains stops anyway.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient, type EngineClientError } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../src/daemon";
import { stubModels } from "./stub-models";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-session-routes-"));
  roots.push(directory);
  return directory;
};
afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function ready() {
  const daemon = await startEngine({ models: stubModels, engineRoot: root() });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: root() });
  await client.createSession({ id: "session_one", projectId: "project_one" });
  await client.registerWorker("worker_one");
  return { daemon, client };
}

/** The canary: an arm that belongs to no feature under migration. */
async function submitTurnStillWorks(client: EngineClient, runId: string) {
  const accepted = await client.submitTurn("session_one", { runId, input: "Hello" });
  expect(accepted).toMatchObject({ replayed: false, turn: { state: "queued" } });
  await client.stopTurn("session_one", runId);
}

test("the canary arm works on its own — a turn is accepted with a run id and a body", async () => {
  // If THIS fails, something upstream is eating the request body before the
  // turn arm reads it. That is exactly what the run door did on its first
  // version, and no run or plugin suite noticed.
  const { client } = await ready();
  await submitTurnStillWorks(client, "run_canary");
});

test("the DS alias answers, and the arm beside it still does", async () => {
  const { client } = await ready();

  // Not enabled, so this is the GATE's refusal — which proves the arm dispatched
  // rather than being absent (an absent arm is a 404 about the path).
  const refused = await client.ds("session_one", "kernel", {}).catch((error: EngineClientError) => error);
  expect((refused as EngineClientError).status).toBe(400);
  expect((refused as EngineClientError).message).toMatch(/not enabled|needs a project/i);

  await submitTurnStillWorks(client, "run_after_ds");
});

test("the LaTeX alias answers, and the arm beside it still does", async () => {
  const { client } = await ready();

  const refused = await client.latex("session_one", "status", {}).catch((error: EngineClientError) => error);
  expect((refused as EngineClientError).status).toBe(400);
  expect((refused as EngineClientError).message).toMatch(/not enabled|needs a project/i);

  await submitTurnStillWorks(client, "run_after_latex");
});

test("the generic plugin door answers for BOTH migrated plugins, beside a working neighbour", async () => {
  const { client } = await ready();

  // The same two features through the generic door. One implementation behind
  // both, so these refuse in the same words the aliases did.
  for (const id of ["data-science", "latex"]) {
    const refused = await client.plugin("session_one", id, id === "latex" ? "status" : "kernel", {}).catch((e: EngineClientError) => e);
    expect((refused as EngineClientError).status).toBe(400);
    expect((refused as EngineClientError).message).toMatch(/not enabled/i);
  }

  // An unknown plugin is a 404 ABOUT THE PLUGIN, which is how we know the arm
  // is dispatching rather than the path being unrouted.
  await expect(client.plugin("session_one", "no-such-plugin", "ping", {})).rejects.toMatchObject({ status: 404 });

  await submitTurnStillWorks(client, "run_after_plugins");
});

test("the run door answers, and the arm beside it still does", async () => {
  const { client } = await ready();

  // A GET with no configurations — the run mount's own answer, not a 404.
  await expect(client.runConfigurations("session_one")).resolves.toMatchObject({ configurations: [] });

  // …and a refusal from the run surface is a refusal, not a crash.
  await expect(client.runStatus("session_one")).resolves.toMatchObject({ history: [] });

  await submitTurnStillWorks(client, "run_after_run");
});

test("every migrated door is reachable in ONE session, in sequence", async () => {
  // The combined case: if any arm shadows or consumes another, the sequence
  // breaks even though each suite passes alone.
  const { client } = await ready();

  await expect(client.runConfigurations("session_one")).resolves.toMatchObject({ configurations: [] });
  await expect(client.ds("session_one", "kernel", {})).rejects.toMatchObject({ status: 400 });
  await expect(client.latex("session_one", "status", {})).rejects.toMatchObject({ status: 400 });
  await expect(client.plugin("session_one", "latex", "status", {})).rejects.toMatchObject({ status: 400 });
  await submitTurnStillWorks(client, "run_sequence");
  // …and the plugin health document still reports both migrated plugins ready.
  const health = await client.health();
  expect(health.plugins?.map((status) => status.meta.id).sort()).toEqual(["data-science", "latex"]);
});
