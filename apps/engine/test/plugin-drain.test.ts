/**
 * DRAIN, AND THE TWO WAYS IT WENT WRONG.
 *
 * Disabling a plugin lets running work FINISH. That is the semantics, and both
 * defects here were ways of breaking it:
 *
 *   1. The ceiling never arrived. `watchDrain` recomputed its deadline on every
 *      poll, so a busy project was watched forever and the bound was decorative.
 *   2. A re-enable did not supersede a pending drain. disable → still busy →
 *      re-enable left the old timer ticking, and when the project finally went
 *      idle it disposed the resources of a project that was live again.
 *
 * And the fix for (1) must not become a third way of breaking it: reaching the
 * ceiling STOPS POLLING and says so. It does not release. A bound on a poll loop
 * is not a licence to tear a running training cell out from under someone.
 *
 * Every case drives real time through a tiny poll interval rather than mocking
 * the clock, so what is asserted is the host's actual behaviour.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PLUGIN_API_VERSION, type PluginMeta } from "@telar/engine-client";
import type { PluginEngineModule } from "../src/plugins/contract";
import { PluginHost } from "../src/plugins/host";

const dirs: string[] = [];
const hosts: PluginHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.disposeAll("shutdown");
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const meta = (id: string): PluginMeta => ({
  id,
  api: PLUGIN_API_VERSION,
  name: id,
  version: "1.0.0",
  toolPrefixes: [id],
  readTools: [],
  eventKinds: [],
  settings: [],
});

/** A plugin whose busy-ness and releases the test controls and observes. */
function watched(id: string) {
  const state = { busy: false, released: [] as string[] };
  const module: PluginEngineModule = {
    meta: meta(id),
    hooks: {
      drain: () => undefined,
      busy: () => state.busy,
      releaseProject: (projectId) => void state.released.push(projectId),
    },
  };
  return { state, module };
}

function host(modules: PluginEngineModule[], drainPollMs = 5) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-drain-"));
  dirs.push(dir);
  const created = new PluginHost(modules, {
    daemonId: "d1",
    stateDir: dir,
    drainPollMs,
    declaredPrefixes: modules.flatMap((module) => module.meta.toolPrefixes),
  });
  hosts.push(created);
  return created;
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("an idle project releases immediately", async () => {
  const { state, module } = watched("alpha");
  const created = host([module]);
  await created.startAll();

  const outcome = await created.drainProject("alpha", "project_one");
  expect(outcome).toEqual({ drained: true, stillBusy: false });
  expect(state.released).toEqual(["project_one"]);
});

test("a BUSY project is not released until its work finishes", async () => {
  // The whole point of a drain: unticking a switch does not kill a running cell.
  const { state, module } = watched("alpha");
  state.busy = true;
  const created = host([module]);
  await created.startAll();

  const outcome = await created.drainProject("alpha", "project_one");
  expect(outcome).toEqual({ drained: true, stillBusy: true });

  await settle(40);
  expect(state.released).toEqual([]); // still working — untouched

  state.busy = false;
  await settle(40);
  expect(state.released).toEqual(["project_one"]); // finished, then released
});

test("RE-ENABLING supersedes a pending drain — the live project is never disposed", async () => {
  // The hazard: disable while busy, re-enable, work ends. The old timer must not
  // release resources the project is using again.
  const { state, module } = watched("alpha");
  state.busy = true;
  const created = host([module]);
  await created.startAll();

  await created.drainProject("alpha", "project_one");
  created.cancelDrain("alpha", "project_one"); // the project turned it back on

  state.busy = false; // the work that was running finishes
  await settle(60);
  expect(state.released).toEqual([]); // NOT released — it is live again
});

test("a second drain supersedes the first, and only one release happens", async () => {
  const { state, module } = watched("alpha");
  state.busy = true;
  const created = host([module]);
  await created.startAll();

  await created.drainProject("alpha", "project_one");
  await created.drainProject("alpha", "project_one");

  state.busy = false;
  await settle(60);
  // One release, not two: a superseded generation returns without acting.
  expect(state.released).toEqual(["project_one"]);
});

test("the ceiling STOPS POLLING and does not release work that is still running", async () => {
  // The bound exists so a plugin whose `busy` is stuck cannot pin a poll loop
  // forever. It must not become a licence to dispose live work.
  const { state, module } = watched("alpha");
  state.busy = true; // never goes false
  const logged: string[] = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-drain-"));
  dirs.push(dir);
  const created = new PluginHost([module], {
    daemonId: "d1",
    stateDir: dir,
    drainPollMs: 1,
    drainMaxMs: 10,
    declaredPrefixes: ["alpha"],
    log: (message) => void logged.push(message),
  });
  hosts.push(created);
  await created.startAll();

  await created.drainProject("alpha", "project_one");
  await settle(60);

  // Reported…
  expect(logged.some((line) => line.includes("resources stay held"))).toBe(true);
  // …and NOT released. The training cell keeps its kernel.
  expect(state.released).toEqual([]);
});

test("two projects drain independently", async () => {
  const { state, module } = watched("alpha");
  const created = host([module]);
  await created.startAll();

  await created.drainProject("alpha", "project_one");
  await created.drainProject("alpha", "project_two");
  expect(state.released.sort()).toEqual(["project_one", "project_two"]);
});
