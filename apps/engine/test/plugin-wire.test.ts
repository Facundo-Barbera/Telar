/**
 * THE GENERIC WIRE, END TO END, WITH NO FEATURE-SPECIFIC BRANCH ANYWHERE ON IT.
 *
 * `hello` is a proof, not a feature: it exists so that this file can assert the
 * claim the whole host rests on — that a plugin reaches an agent and reaches the
 * cockpit without any core file naming it. So every case here goes through a
 * generic door:
 *
 *   the HTTP door   `POST /v2/sessions/:id/plugins/hello/ping`, dispatched by
 *                   the daemon's one `/plugins/:id/:verb` arm
 *   the agent door  the worker's tool wall, built from `bundledPluginToolModules`
 *                   over `EngineClient.plugin()`
 *   the gate        the project's plugin map, read at claim time
 *
 * And the two doors are asserted to reach THE SAME capability shape, because the
 * failure this design exists to prevent is an HTTP verb and a tool drifting into
 * two implementations of one behaviour.
 *
 * Everything runs against a temp engine root. Nothing here reads a real home,
 * and the gate env var is set and restored per case rather than for the file.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient, assertTelarToolNames, type EngineClientError } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../src/daemon";
import { HELLO_GATE, bundledPluginToolModules } from "../src/plugins/bundled";
import { helloToolModule, type HelloCapability } from "../src/plugins/hello";
import { pluginCall } from "../src/plugins/tool-module";
import type { ToolFactory } from "../src/tool-kit";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];
const gates: (string | undefined)[] = [];

/** Turn the proof plugin on for one case, and put the environment back after. */
function gateOn(): void {
  gates.push(process.env[HELLO_GATE]);
  process.env[HELLO_GATE] = "1";
}
function gateOff(): void {
  gates.push(process.env[HELLO_GATE]);
  delete process.env[HELLO_GATE];
}

const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-plugin-wire-"));
  roots.push(directory);
  return directory;
};

afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  for (const previous of gates.splice(0).reverse()) {
    if (previous === undefined) delete process.env[HELLO_GATE];
    else process.env[HELLO_GATE] = previous;
  }
});

/** A daemon, a project, a session — the least state a plugin call needs. */
async function ready(options: { enable?: boolean } = {}): Promise<{ client: EngineClient; sessionId: string; daemon: EngineDaemon }> {
  const daemon = await startEngine({ engineRoot: root() });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: root() });
  if (options.enable) {
    await client.updateProject("project_one", { plugins: { hello: { enabled: true } } });
  }
  await client.createSession({ id: "session_one", projectId: "project_one" });
  return { client, sessionId: "session_one", daemon };
}

/** The worker's half, assembled exactly as `worker.ts` assembles it. */
function wall(client: EngineClient, sessionId: string) {
  const capability = helloToolModule.capability(pluginCall(client, sessionId, helloToolModule.meta.id));
  const registered: { name: string; run: (args: Record<string, unknown>) => Promise<{ content: unknown[]; isError?: boolean }> }[] = [];
  const factory: ToolFactory = (name, _description, _shape, handler) => {
    registered.push({ name, run: handler });
    return { name };
  };
  helloToolModule.tools(factory, capability);
  return { registered, capability: capability as HelloCapability };
}

const text = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text;

test("the gate decides on BOTH sides, and an ungated daemon has no door at all", async () => {
  gateOff();
  expect(bundledPluginToolModules()).toHaveLength(0);
  const { client, sessionId } = await ready({ enable: true });
  const health = await client.health();
  // LaTeX is a migrated plugin and is always registered, so the health document
  // is never empty now. What the gate decides is whether `hello` joins it.
  expect(health.plugins?.map((status) => status.meta.id)).toEqual(["latex"]);
  // The generic arm is still there; it just has nothing to dispatch to. A
  // missing plugin is a 404 about the plugin, not a 500 about the engine.
  await expect(client.plugin(sessionId, "hello", "ping", {})).rejects.toMatchObject({
    status: 404,
    code: "not_found",
  } satisfies Partial<EngineClientError>);
});

test("with the gate on, the HTTP door works and the tool wall goes through the same door", async () => {
  gateOn();
  const { client, sessionId } = await ready({ enable: true });
  const health = await client.health();
  expect(health.plugins?.map((status) => [status.meta.id, status.state])).toEqual([
    ["latex", "ready"],
    ["hello", "ready"],
  ]);

  // The cockpit's door, called generically — no `client.hello()` exists.
  await expect(client.plugin(sessionId, "hello", "ping", { name: "telar" })).resolves.toEqual({ greeted: "telar" });

  // The agent's door. Same daemon, same route, built from the bundled list.
  const { registered, capability } = wall(client, sessionId);
  expect(registered.map((tool) => tool.name)).toEqual(["hello_ping", "hello_state"]);
  expect(() => assertTelarToolNames(registered.map((tool) => tool.name))).not.toThrow();
  const answer = await registered[0]!.run({ name: "telar" });
  expect(answer.isError).toBeUndefined();
  expect(text(answer)).toContain("hello, telar");

  // …and the two doors resolve to the same shape, which is the property that
  // keeps them from drifting into two implementations.
  await expect(capability.ping({ name: "telar" })).resolves.toEqual({ greeted: "telar" });
  await expect(capability.state()).resolves.toEqual({ busy: false });
  await expect(client.plugin(sessionId, "hello", "state")).resolves.toEqual({ busy: false });
});

test("a project that did not opt in is refused at the door, through the tool as an error rather than a throw", async () => {
  gateOn();
  const { client, sessionId } = await ready();
  await expect(client.plugin(sessionId, "hello", "ping", {})).rejects.toMatchObject({
    code: "invalid_request",
  } satisfies Partial<EngineClientError>);
  // The wall reports the refusal as a tool error. An agent gets a sentence it
  // can act on; it does not get an exception that fails the turn.
  const { registered } = wall(client, sessionId);
  const refused = await registered[0]!.run({});
  expect(refused.isError).toBe(true);
  expect(text(refused)).toContain("not enabled");
});

test("disabling removes the entry, and the door closes again with no daemon restart", async () => {
  gateOn();
  const { client, sessionId } = await ready({ enable: true });
  await expect(client.plugin(sessionId, "hello", "ping", {})).resolves.toEqual({ greeted: "world" });
  await client.updateProject("project_one", { plugins: { hello: null } });
  await expect(client.plugin(sessionId, "hello", "ping", {})).rejects.toMatchObject({ code: "invalid_request" });
});

test("the claim carries enabled plugin ids, and never the two that have their own fields", async () => {
  gateOn();
  const { client, sessionId } = await ready({ enable: true });
  // Both mirrored features on as well, so the exclusion is asserted against a
  // map that actually contains them rather than against an empty one.
  await client.updateProject("project_one", { latex: { enabled: true } });
  await client.registerWorker("worker_one");
  await client.submitTurn(sessionId, { runId: "run_one", input: "Hello" });
  const claim = (await client.claimTurn("worker_one")).claim!;
  expect(claim.plugins).toEqual(["hello"]);

  // And the worker builds exactly the walls the claim names.
  const built = bundledPluginToolModules().filter((module) => claim.plugins?.includes(module.meta.id));
  expect(built.map((module) => module.meta.id)).toEqual(["hello"]);
});

test("a plugin id on the claim that this binary does not bundle builds no wall rather than crashing", () => {
  gateOn();
  const claim = { plugins: ["hello", "some-plugin-from-a-newer-daemon"] };
  const built = bundledPluginToolModules().filter((module) => claim.plugins.includes(module.meta.id));
  expect(built.map((module) => module.meta.id)).toEqual(["hello"]);
});
