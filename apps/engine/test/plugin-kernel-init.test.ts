/**
 * THE KERNEL HOST IS DATA SCIENCE'S, BUILT BY ITS `init` — P1b part 2.
 *
 *   built      `init` builds the host, hands it to the store, and registers its
 *              teardown in the same step
 *   absent     a daemon that runs no turns (no embedded worker) still has no
 *              kernels, and a kernel verb refuses as it always did
 *   hooks      `busy` and release read the host `init` built
 *
 * Temp engine root; no interpreter is ever spawned.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient, type EngineClientError } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../src/daemon";
import { KernelHost } from "../src/domains/plugins/data-science/kernel-host";
import { dataSciencePlugin } from "../src/domains/plugins/data-science/plugin";
import type { PluginInitContext } from "../src/domains/plugins/contract";
import { stubModels } from "./stub-models";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-kernel-init-"));
  roots.push(directory);
  return directory;
};

afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const unusedSettings = {} as Parameters<typeof dataSciencePlugin>[0]["settings"];

function initContext() {
  const cleanups: { name: string; run: () => void | Promise<void> }[] = [];
  const context = {
    daemonId: "daemon_test",
    stateDir: root(),
    work: {} as PluginInitContext["work"],
    onDispose: (name: string, run: () => void | Promise<void>) => void cleanups.push({ name, run }),
  } satisfies PluginInitContext;
  return { context, cleanups };
}

test("init builds the kernel host, attaches it, and registers its teardown", async () => {
  const engineRoot = root();
  const attached: KernelHost[] = [];
  const plugin = dataSciencePlugin({
    resolve: () => {
      throw new Error("not used");
    },
    projectOf: () => "project_one",
    settings: unusedSettings,
    kernelHost: { options: { engineRoot, sessionDir: (id) => path.join(engineRoot, "sessions", id) }, attach: (host) => void attached.push(host) },
  });
  const { context, cleanups } = initContext();
  await plugin.init?.(context);

  expect(attached).toHaveLength(1);
  expect(attached[0]).toBeInstanceOf(KernelHost);
  expect(cleanups.map((cleanup) => cleanup.name)).toEqual(["data science kernels"]);
  // The hooks read the host `init` built: no kernels, so nothing is busy.
  expect(plugin.hooks?.busy?.("project_one")).toBe(false);
  await plugin.hooks?.releaseProject?.("project_one");
  await cleanups[0]!.run();
});

test("without a kernel host to build, init acquires nothing and the hooks are idle", async () => {
  const plugin = dataSciencePlugin({
    resolve: () => {
      throw new Error("not used");
    },
    projectOf: () => undefined,
    settings: unusedSettings,
  });
  const { context, cleanups } = initContext();
  await plugin.init?.(context);
  expect(cleanups).toEqual([]);
  expect(plugin.hooks?.busy?.("project_one")).toBe(false);
  plugin.hooks?.releaseSession?.("session_one", "archived");
});

test("a daemon with no embedded worker has no kernels, as before", async () => {
  const daemon = await startEngine({ models: stubModels, engineRoot: root() });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: root() });
  await client.updateProject("project_one", {
    dataScience: { enabled: true, python: { source: "chosen", path: "/bin/ls", resolvedAt: Date.now() } },
  });
  await client.createSession({ id: "session_one", projectId: "project_one" });
  const refused = await client.plugin("session_one", "data-science", "kernel", {}).catch((error: EngineClientError) => error);
  expect((refused as EngineClientError).message).toContain("this engine has no kernel host");
});

test("a daemon with an embedded worker builds the host at startup, through the plugin", async () => {
  const daemon = await startEngine({
    models: stubModels,
    engineRoot: root(),
    embeddedWorker: { createDriver: () => ({ run: async () => ({ text: "ok" }) }), pollMs: 20 },
  });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: root() });
  await client.updateProject("project_one", {
    dataScience: { enabled: true, python: { source: "chosen", path: "/bin/ls", resolvedAt: Date.now() } },
  });
  await client.createSession({ id: "session_one", projectId: "project_one" });
  // The host exists, so the kernel verb reaches it and answers rather than
  // refusing — a session with no kernel started reports its state.
  const answer = await client.plugin<{ state?: string }>("session_one", "data-science", "kernel", {});
  expect(answer).toBeDefined();
});
