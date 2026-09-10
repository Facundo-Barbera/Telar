/**
 * THE MACHINE CEILING — global disable, and what it must and must not touch.
 *
 * `effective = machine AND project`, so every case here checks the ENFORCEMENT
 * rather than the presentation: the generic plugin door, the legacy `/ds/` and
 * `/latex/` aliases, the claim a worker builds its tool walls from, and the
 * resolver a capability comes out of. A cockpit hiding a switch would not be
 * enforcement, and a test that only read the switch back would not be evidence.
 *
 * The two properties that make global disable safe to use are asserted in as
 * many words: project settings SURVIVE it, and running work is DRAINED rather
 * than killed.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient, machineAllows, pluginEffectivelyEnabled, readProjectPlugins, type EngineClientError } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../src/daemon";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-machine-plugins-"));
  roots.push(directory);
  return directory;
};
afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

/** A project with LaTeX on and a toolchain that exists on disk. */
async function ready() {
  const daemon = await startEngine({ engineRoot: root() });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: root() });
  await client.updateProject("project_one", {
    latex: { enabled: true, mainFile: "paper.tex", toolchain: { kind: "texlive", path: "/bin/echo" } },
  });
  await client.createSession({ id: "session_one", projectId: "project_one" });
  await client.registerWorker("worker_one");
  return { daemon, client, store: daemon.store };
}

const machine = (daemon: EngineDaemon, plugins: Record<string, { enabled: boolean; settings?: Record<string, unknown> } | null>) =>
  fetch(`http://127.0.0.1:${daemon.discovery.port}/v2/plugins`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${daemon.discovery.token}`, "content-type": "application/json" },
    body: JSON.stringify({ plugins }),
  });

test("absence of a global entry means ALLOWED — an upgrade disables nothing", () => {
  // Reading absence as "off" would silently switch off every working setup on a
  // machine that predates this file.
  expect(machineAllows(undefined, "latex")).toBe(true);
  expect(machineAllows({ version: 1, entries: {} }, "latex")).toBe(true);
  // …and it never ENABLES anything: the project still has to have asked.
  expect(pluginEffectivelyEnabled(undefined, { version: 1, entries: {} }, "latex")).toBe(false);
});

test("a globally disabled plugin is refused at EVERY door, not just hidden", async () => {
  const { daemon, client } = await ready();
  // Working first, through both doors.
  await expect(client.latex("session_one", "status", {})).resolves.toBeDefined();
  await expect(client.plugin("session_one", "latex", "status", {})).resolves.toBeDefined();

  expect((await machine(daemon, { latex: { enabled: false } })).status).toBe(200);

  // The legacy alias, the generic door — both refuse, and say which switch.
  for (const call of [client.latex("session_one", "status", {}), client.plugin("session_one", "latex", "status", {})]) {
    const refused = await call.catch((error: EngineClientError) => error);
    expect((refused as EngineClientError).status).toBe(400);
    expect((refused as EngineClientError).message).toContain("this Mac");
  }
});

test("a globally disabled plugin does not reach a worker's CLAIM", async () => {
  // The wall a worker builds comes from the claim. If the ceiling were only a
  // frontend rule, the tools would still be registered for the turn.
  const { daemon, client, store } = await ready();
  await client.updateProject("project_one", { plugins: { hello: { enabled: true } } });
  expect(store.enabledPluginIds(store.getSession("session_one"))).toEqual(["hello"]);

  expect((await machine(daemon, { hello: { enabled: false } })).status).toBe(200);
  expect(store.enabledPluginIds(store.getSession("session_one"))).toEqual([]);
});

test("the CAPABILITY RESOLVER refuses too, so a tool wall cannot reach a runtime", async () => {
  const { daemon, store } = await ready();
  expect(store.resolveLatex(store.getSession("session_one"))).toBeDefined();
  await machine(daemon, { latex: { enabled: false } });
  expect(store.resolveLatex(store.getSession("session_one"))).toBeUndefined();
});

test("PROJECT SETTINGS SURVIVE a global disable, and re-enabling restores them", async () => {
  const { daemon, client, store } = await ready();
  await machine(daemon, { latex: { enabled: false } });

  // The project's own configuration is untouched — that is what makes this a
  // ceiling rather than a rewrite.
  const stored = store.getProject("project_one");
  expect(stored.latex).toEqual({ enabled: true, mainFile: "paper.tex", toolchain: { kind: "texlive", path: "/bin/echo" } });
  expect(readProjectPlugins(stored).plugins.entries.latex?.enabled).toBe(true);

  await machine(daemon, { latex: { enabled: true } });
  await expect(client.latex("session_one", "status", {})).resolves.toBeDefined();
});

test("a globally disabled project keeps its OWN switch answerable", async () => {
  // A person may still turn a project's plugin off while the Mac's is off, and
  // that decision must be recorded rather than swallowed.
  const { daemon, client, store } = await ready();
  await machine(daemon, { latex: { enabled: false } });
  await client.updateProject("project_one", { latex: null });
  expect(store.getProject("project_one").latex).toBeUndefined();
});

test("the MACHINE'S TeX install is a real fallback, not an inert stored field", async () => {
  // A machine setting that only persisted would be a lie in the settings pane.
  const { daemon, client, store } = await ready();
  // A project with LaTeX on but NO toolchain of its own.
  await client.updateProject("project_one", { latex: { enabled: true, mainFile: "paper.tex" } });
  expect(store.resolveLatex(store.getSession("session_one"))).toBeUndefined();

  await machine(daemon, { latex: { enabled: true, settings: { toolchain: { kind: "texlive", path: "/bin/echo" } } } });
  expect(store.resolveLatex(store.getSession("session_one"))).toMatchObject({ binPath: "/bin/echo", kind: "texlive" });
});

test("a project's OWN toolchain still wins — the more specific choice", async () => {
  const { daemon, client, store } = await ready();
  await machine(daemon, { latex: { enabled: true, settings: { toolchain: { kind: "tectonic", path: "/bin/ls" } } } });
  await client.updateProject("project_one", { latex: { enabled: true, toolchain: { kind: "texlive", path: "/bin/echo" } } });
  expect(store.resolveLatex(store.getSession("session_one"))).toMatchObject({ binPath: "/bin/echo" });
});

test("machine settings are validated by the PLUGIN's own schema", async () => {
  const { daemon } = await ready();
  const bad = await machine(daemon, { latex: { enabled: true, settings: { toolchain: { kind: "texlive" } } } });
  expect(bad.status).toBe(400);
  expect(JSON.stringify(await bad.json())).toContain("not valid for latex");
});

test("the machine map SURVIVES A RESTART", async () => {
  const { daemon } = await ready();
  await machine(daemon, { latex: { enabled: false } });
  const home = daemon.store.paths.root;
  await daemon.close();
  daemons.length = 0;

  const restarted = await startEngine({ engineRoot: home });
  daemons.push(restarted);
  expect(machineAllows(restarted.store.machinePlugins(), "latex")).toBe(false);
  // …and the project's settings came back untouched with it.
  expect(restarted.store.getProject("project_one").latex?.mainFile).toBe("paper.tex");
});

test("GET reports what this Mac allows beside what it has registered", async () => {
  const { daemon } = await ready();
  await machine(daemon, { latex: { enabled: false } });
  const answer = await fetch(`http://127.0.0.1:${daemon.discovery.port}/v2/plugins`, {
    headers: { authorization: `Bearer ${daemon.discovery.token}` },
  });
  const body = (await answer.json()) as { plugins: { meta: { id: string } }[]; machine: { entries: Record<string, { enabled: boolean }> } };
  expect(body.plugins.map((status) => status.meta.id).sort()).toEqual(["data-science", "latex"]);
  expect(body.machine.entries.latex?.enabled).toBe(false);
});
