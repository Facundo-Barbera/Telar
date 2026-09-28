/**
 * EXTERNAL PLUGINS (P4): a folder with a manifest becomes a plugin the host
 * runs as a supervised child, through the same doors a bundled one uses.
 *
 *   the manifest   validated strictly; a bad one is REFUSED — listed as failed
 *                  with its reason — and the engine starts regardless
 *   the process    started on first use, restarted with backoff when it dies,
 *                  stopped for good by `stop` (fake spawn, fake timers)
 *   the tools      declared in the manifest, walled under `mcp__telar__<prefix>_*`,
 *                  called end to end against a real short-lived child
 *   approval       never read-ratified: every external tool parks a card
 */
import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { EngineClient, parsePluginPanelView } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../src/daemon";
import { requestKindForTool } from "../src/drivers/claude";
import { loadInstalledPlugins } from "../src/plugins/external/manifest";
import { externalMeta, externalToolModule } from "../src/plugins/external/module";
import { ExternalPluginProcess, RESTART_BACKOFF_MS, type PluginChild, type PluginTimers } from "../src/plugins/external/process";
import { pluginToolModules } from "../src/plugins/bundled";
import { ratifiedReadTools } from "../src/plugins/policy";
import { pluginCall } from "../src/plugins/tool-module";
import type { ToolFactory } from "../src/tool-kit";
import { ECHO_MANIFEST, writePlugin } from "./fixtures/external-plugin";
import { stubModels } from "./stub-models";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];

const tempDir = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-plugin-external-"));
  roots.push(directory);
  return directory;
};

afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("the manifest", () => {
  test("a valid folder loads; every broken one is refused with the reason, and none throws", () => {
    const dir = tempDir();
    writePlugin(dir, "echo");
    writePlugin(dir, "broken-json", "{ not json");
    writePlugin(dir, "wrong-api", { ...ECHO_MANIFEST, id: "wrong-api", api: 99 });
    writePlugin(dir, "elsewhere", { ...ECHO_MANIFEST, id: "somewhere" });
    writePlugin(dir, "latex", { ...ECHO_MANIFEST, id: "latex" });
    writePlugin(dir, "prefix-thief", { ...ECHO_MANIFEST, id: "prefix-thief", toolPrefix: "ds", tools: [] });
    writePlugin(dir, "no-program", { ...ECHO_MANIFEST, id: "no-program", toolPrefix: "nop", tools: [], command: ["./missing"] });
    writePlugin(dir, "claims-reads", { ...ECHO_MANIFEST, id: "claims-reads", toolPrefix: "cr", tools: [], readTools: ["cr_all"] });
    writePlugin(dir, "bad-tool", {
      ...ECHO_MANIFEST,
      id: "bad-tool",
      toolPrefix: "bt",
      tools: [{ name: "other_tool", description: "Not mine." }],
    });
    fs.mkdirSync(path.join(dir, "Not An Id"));

    const { loaded, refused } = loadInstalledPlugins(dir);
    expect(loaded.map((plugin) => plugin.manifest.id)).toEqual(["echo"]);
    const reasons = Object.fromEntries(refused.map((plugin) => [plugin.meta.id, plugin.error]));
    expect(reasons["broken-json"]).toContain("not valid JSON");
    expect(reasons["wrong-api"]).toContain("api");
    expect(reasons.elsewhere).toContain('does not match its folder "elsewhere"');
    expect(reasons.latex).toContain("already taken");
    expect(reasons["prefix-thief"]).toContain('tool prefix "ds"');
    expect(reasons["no-program"]).toContain("not in the plugin's folder");
    // Strict: a read claim is not a key a manifest may carry at all.
    expect(reasons["claims-reads"]).toContain("readTools");
    expect(reasons["bad-tool"]).toContain("tools.0.name");
    expect(reasons["invalid-not-an-id"]).toContain("missing");
    // A refused listing claims nothing.
    for (const plugin of refused) expect(plugin.meta.toolPrefixes).toEqual([]);
  });

  test("no plugins folder is the normal case, not an error", () => {
    expect(loadInstalledPlugins(path.join(tempDir(), "absent"))).toEqual({ loaded: [], refused: [] });
  });
});

/** A child the test drives by hand: it answers `initialize`, and `die` ends it. */
class FakeChild extends EventEmitter implements PluginChild {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed: string[] = [];
  constructor() {
    super();
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string) => {
      for (const line of chunk.split("\n").filter(Boolean)) {
        const message = JSON.parse(line) as { id?: number; method: string };
        if (message.id !== undefined && message.method === "initialize") this.answer(message.id, {});
      }
    });
  }
  answer(id: number, result: unknown) {
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }
  die(code = 1) {
    this.emit("exit", code, null);
  }
  kill(signal: NodeJS.Signals = "SIGTERM") {
    this.killed.push(signal);
    queueMicrotask(() => this.emit("exit", null, signal));
    return true;
  }
}

/** Timers the test advances by hand. */
function fakeTimers() {
  let now = 0;
  const pending: { at: number; run: () => void; id: number }[] = [];
  let nextId = 0;
  const timers: PluginTimers = {
    setTimeout: (run, ms) => {
      const id = ++nextId;
      pending.push({ at: now + ms, run, id });
      return id;
    },
    clearTimeout: (handle) => {
      const index = pending.findIndex((timer) => timer.id === handle);
      if (index >= 0) pending.splice(index, 1);
    },
    now: () => now,
  };
  return {
    timers,
    /** Delays scheduled but not yet run, soonest first. */
    delays: () => pending.map((timer) => timer.at - now).sort((a, b) => a - b),
    advance(ms: number) {
      now += ms;
      for (const timer of pending.filter((candidate) => candidate.at <= now)) {
        pending.splice(pending.indexOf(timer), 1);
        timer.run();
      }
    },
  };
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("the process", () => {
  test("starts on first use, restarts with growing backoff, and stays stopped after stop", async () => {
    const clock = fakeTimers();
    const children: FakeChild[] = [];
    const supervised = new ExternalPluginProcess({
      id: "echo",
      dir: tempDir(),
      command: ["./server"],
      stateDir: tempDir(),
      timers: clock.timers,
      spawn: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
    });
    expect(supervised.state).toBe("stopped");
    expect(children).toHaveLength(0);

    await supervised.ensureStarted();
    expect(supervised.state).toBe("running");
    expect(children).toHaveLength(1);

    // First crash: back off by the first step, then start again.
    children[0]!.stderr.write("something broke\n");
    children[0]!.die();
    expect(supervised.state).toBe("backoff");
    expect(clock.delays()).toContain(RESTART_BACKOFF_MS[0]);
    clock.advance(RESTART_BACKOFF_MS[0]);
    await settle();
    expect(children).toHaveLength(2);
    expect(supervised.state).toBe("running");
    expect(supervised.restarts).toBe(1);

    // A second crash soon after waits longer.
    children[1]!.die();
    expect(clock.delays()).toContain(RESTART_BACKOFF_MS[1]);
    clock.advance(RESTART_BACKOFF_MS[1]);
    await settle();
    expect(children).toHaveLength(3);

    // The log kept both what the plugin wrote and the supervisor's own line.
    expect(supervised.logs()).toContain("something broke");
    expect(supervised.logs().some((line) => line.includes("restarting in"))).toBe(true);

    // Stop: the child is terminated, and a crash-timer that is pending never fires.
    await supervised.stop();
    expect(children[2]!.killed).toEqual(["SIGTERM"]);
    expect(supervised.state).toBe("stopped");
    clock.advance(60_000);
    await settle();
    expect(children).toHaveLength(3);
  });

  test("a start that stayed up resets the backoff", async () => {
    const clock = fakeTimers();
    const children: FakeChild[] = [];
    const supervised = new ExternalPluginProcess({
      id: "echo",
      dir: tempDir(),
      command: ["./server"],
      stateDir: tempDir(),
      timers: clock.timers,
      spawn: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
    });
    await supervised.ensureStarted();
    children[0]!.die();
    clock.advance(RESTART_BACKOFF_MS[0]);
    await settle();
    // Healthy for a minute, then a one-off crash: back to the first step.
    clock.advance(60_000);
    children[1]!.die();
    expect(clock.delays()).toEqual([RESTART_BACKOFF_MS[0]]);
    await supervised.stop();
  });

  test("a request in flight when the child dies is refused, not left hanging", async () => {
    const clock = fakeTimers();
    let child: FakeChild | undefined;
    const supervised = new ExternalPluginProcess({
      id: "echo",
      dir: tempDir(),
      command: ["./server"],
      stateDir: tempDir(),
      timers: clock.timers,
      spawn: () => (child = new FakeChild()),
    });
    const call = supervised.request("tools/call", { name: "echo_say", arguments: {} });
    await settle();
    expect(supervised.busy).toBe(true);
    child!.die();
    await expect(call).rejects.toThrow("echo exited with code 1");
    expect(supervised.busy).toBe(false);
    await supervised.stop();
  });
});

describe("the daemon", () => {
  async function ready(pluginsDir: string) {
    const engineRoot = tempDir();
    fs.writeFileSync(path.join(engineRoot, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
    const daemon = await startEngine({ models: stubModels, engineRoot, pluginsDir });
    daemons.push(daemon);
    const client = new EngineClient(daemon.discovery);
    await client.registerProject({ id: "project_one", name: "One", root: tempDir() });
    await client.createSession({ id: "session_one", projectId: "project_one" });
    return { client, sessionId: "session_one" };
  }

  test("a bad manifest is listed as failed with its reason, and everything else still starts", async () => {
    const pluginsDir = tempDir();
    writePlugin(pluginsDir, "echo");
    writePlugin(pluginsDir, "broken", "{");
    const { client } = await ready(pluginsDir);
    const plugins = (await client.health()).plugins ?? [];
    const byId = Object.fromEntries(plugins.map((status) => [status.meta.id, status]));
    expect(byId.latex?.state).toBe("ready");
    expect(byId.echo?.state).toBe("ready");
    expect(byId.echo?.meta.toolPrefixes).toEqual(["echo"]);
    expect(byId.echo?.meta.readTools).toEqual([]);
    // Its panels, for the cockpit's "Plugins" tab.
    expect(byId.echo?.meta.panels).toEqual([{ id: "status", label: "Status", verb: "status" }]);
    // Published as the manifest wrote it, for the generated settings pane.
    expect(byId.echo?.settingsSchema).toEqual(ECHO_MANIFEST.settingsSchema);
    expect(byId.broken?.state).toBe("failed");
    expect(byId.broken?.error).toContain("plugin.json: not valid JSON");
  });

  test("the declared tool reaches the child through the session door, gated like any plugin", async () => {
    const pluginsDir = tempDir();
    writePlugin(pluginsDir, "echo");
    const plugin = loadInstalledPlugins(pluginsDir).loaded[0]!;
    const { client, sessionId } = await ready(pluginsDir);

    // The worker's wall, built the way the worker builds it.
    const module = externalToolModule(plugin);
    const registered: { name: string; run: (args: Record<string, unknown>) => Promise<{ content: unknown[]; isError?: boolean }> }[] = [];
    const factory: ToolFactory = (name, _description, _shape, handler) => {
      registered.push({ name, run: handler });
      return { name };
    };
    module.tools(factory, module.capability(pluginCall(client, sessionId, "echo")));
    expect(registered.map((tool) => tool.name)).toEqual(["echo_say"]);

    // Off for the project: the tool is an error the agent can read, and nothing spawned.
    const refused = await registered[0]!.run({ text: "hi" });
    expect(refused.isError).toBe(true);

    await client.updateProject("project_one", { plugins: { echo: { enabled: true } } });
    const answer = await registered[0]!.run({ text: "hi" });
    expect(answer).toEqual({ content: [{ type: "text", text: "echo: hi" }] });
    await expect(client.plugin(sessionId, "echo", "status", {})).resolves.toEqual({
      scope: "session",
      verb: "status",
      sessionId,
      projectId: "project_one",
    });
    // The settings in force travel with every call.
    await client.updateProject("project_one", { plugins: { echo: { enabled: true, settings: { greeting: "hey" } } } });
    await expect(registered[0]!.run({ text: "hi" })).resolves.toEqual({ content: [{ type: "text", text: "hey: hi" }] });
    // Only declared tools pass the door.
    await expect(client.plugin(sessionId, "echo", "tool", { name: "echo_other" })).rejects.toThrow("has no tool echo_other");
  });
});

describe("install and remove", () => {
  async function engine() {
    const pluginsDir = path.join(tempDir(), "plugins");
    const engineRoot = tempDir();
    fs.writeFileSync(path.join(engineRoot, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
    const daemon = await startEngine({ models: stubModels, engineRoot, pluginsDir });
    daemons.push(daemon);
    const client = new EngineClient(daemon.discovery);
    await client.registerProject({ id: "project_one", name: "One", root: tempDir() });
    await client.createSession({ id: "session_one", projectId: "project_one" });
    return { client, pluginsDir };
  }
  const ids = async (client: EngineClient) => ((await client.machinePlugins()).plugins ?? []).map((status) => status.meta.id);

  test("a copied plugin runs without a restart, and removing it stops it and deletes the copy", async () => {
    const { client, pluginsDir } = await engine();
    const source = writePlugin(tempDir(), "anything-named");
    const { plugin } = await client.installPlugin({ path: source });
    expect(plugin).toMatchObject({ meta: { id: "echo" }, state: "ready", installed: { linked: false } });
    expect(fs.existsSync(path.join(pluginsDir, "echo", "plugin.json"))).toBe(true);
    expect(pluginToolModules().some((module) => module.meta.id === "echo")).toBe(true);

    await client.updateProject("project_one", { plugins: { echo: { enabled: true } } });
    await expect(client.plugin("session_one", "echo", "tool", { name: "echo_say", arguments: { text: "hi" } })).resolves.toEqual({
      content: [{ type: "text", text: "echo: hi" }],
    });

    await expect(client.uninstallPlugin("echo")).resolves.toEqual({ removed: true });
    expect(fs.existsSync(path.join(pluginsDir, "echo"))).toBe(false);
    expect(fs.existsSync(source)).toBe(true);
    expect(await ids(client)).not.toContain("echo");
    expect(pluginToolModules().some((module) => module.meta.id === "echo")).toBe(false);
    await expect(client.plugin("session_one", "echo", "status", {})).rejects.toMatchObject({ status: 404 });
  });

  test("a linked plugin is only unlinked: the owner's folder stays", async () => {
    const { client, pluginsDir } = await engine();
    const source = writePlugin(tempDir(), "echo");
    const { plugin } = await client.installPlugin({ path: source, mode: "link" });
    expect(plugin.installed).toEqual({ linked: true });
    expect(fs.lstatSync(path.join(pluginsDir, "echo")).isSymbolicLink()).toBe(true);
    await client.uninstallPlugin("echo");
    expect(fs.existsSync(path.join(pluginsDir, "echo"))).toBe(false);
    expect(fs.existsSync(path.join(source, "plugin.json"))).toBe(true);
  });

  test("a folder that would be refused is not installed, and says why", async () => {
    const { client, pluginsDir } = await engine();
    await expect(client.installPlugin({ path: writePlugin(tempDir(), "bad", "{") })).rejects.toThrow("not valid JSON");
    await expect(client.installPlugin({ path: writePlugin(tempDir(), "latex", { ...ECHO_MANIFEST, id: "latex" }) })).rejects.toThrow("already taken");
    await expect(client.installPlugin({ path: writePlugin(tempDir(), "installed", { ...ECHO_MANIFEST, id: "installed" }) })).rejects.toThrow("already taken");
    await expect(client.installPlugin({ path: "relative/path" })).rejects.toThrow("absolute");
    expect(fs.existsSync(pluginsDir) ? fs.readdirSync(pluginsDir) : []).toEqual([]);

    // Twice is refused too, and a second prefix owner with it.
    await client.installPlugin({ path: writePlugin(tempDir(), "echo") });
    await expect(client.installPlugin({ path: writePlugin(tempDir(), "echo") })).rejects.toThrow("already");
    await expect(client.installPlugin({ path: writePlugin(tempDir(), "other", { ...ECHO_MANIFEST, id: "other" }) })).rejects.toThrow('tool prefix "echo"');
  });

  test("a broken folder found at start can be removed from Settings", async () => {
    const pluginsDir = path.join(tempDir(), "plugins");
    writePlugin(pluginsDir, "broken", "{");
    const engineRoot = tempDir();
    const daemon = await startEngine({ models: stubModels, engineRoot, pluginsDir });
    daemons.push(daemon);
    const client = new EngineClient(daemon.discovery);
    const broken = (await client.machinePlugins()).plugins.find((status) => status.meta.id === "broken");
    expect(broken).toMatchObject({ state: "failed", installed: { linked: false } });
    await client.uninstallPlugin("broken");
    expect(fs.existsSync(path.join(pluginsDir, "broken"))).toBe(false);
    expect(await ids(client)).not.toContain("broken");
    await expect(client.uninstallPlugin("latex")).rejects.toMatchObject({ status: 404 });
  });
});

describe("the example plugin", () => {
  test("examples/plugins/tally installs, counts with its setting, draws its panel and resets", async () => {
    const example = path.resolve(import.meta.dir, "../../../examples/plugins/tally");
    const pluginsDir = path.join(tempDir(), "plugins");
    const engineRoot = tempDir();
    fs.writeFileSync(path.join(engineRoot, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
    const daemon = await startEngine({ models: stubModels, engineRoot, pluginsDir });
    daemons.push(daemon);
    const client = new EngineClient(daemon.discovery);
    await client.registerProject({ id: "project_one", name: "One", root: tempDir() });
    await client.createSession({ id: "session_one", projectId: "project_one" });

    const { plugin } = await client.installPlugin({ path: example });
    expect(plugin).toMatchObject({ meta: { id: "tally", toolPrefixes: ["tally"], readTools: [], panels: [{ id: "counts" }] }, state: "ready" });
    expect(plugin.settingsSchema).toMatchObject({ properties: { step: { type: "integer" } } });
    // The copy is what runs; the example folder is never written to.
    expect(fs.existsSync(path.join(pluginsDir, "tally", "server.mjs"))).toBe(true);

    await client.updateProject("project_one", { plugins: { tally: { enabled: true, settings: { step: 2 } } } });
    const count = (label: string) => client.plugin("session_one", "tally", "tool", { name: "tally_count", arguments: { label } });
    await count("apples");
    await expect(count("apples")).resolves.toEqual({ content: [{ type: "text", text: "apples: 4" }] });

    const view = parsePluginPanelView(await client.plugin("session_one", "tally", "counts", {}));
    expect(view.skipped).toBe(0);
    expect(view.blocks.find((block) => block.type === "table")).toEqual({ type: "table", columns: ["Label", "Count"], rows: [["apples", 4]] });
    expect(view.blocks.find((block) => block.type === "keyValue")).toEqual({ type: "keyValue", items: [{ key: "Step", value: 2 }] });
    const reset = view.blocks.find((block) => block.type === "action");
    expect(reset).toMatchObject({ verb: "reset" });

    await client.plugin("session_one", "tally", "reset", {});
    const after = parsePluginPanelView(await client.plugin("session_one", "tally", "counts", {}));
    expect(after.blocks.some((block) => block.type === "table")).toBe(false);
    await client.uninstallPlugin("tally");
  });
});

describe("approval", () => {
  test("an external tool is never read-ratified, so it always parks a card", () => {
    const meta = externalMeta({ ...ECHO_MANIFEST, routes: { session: [], project: [], machine: [] } } as never);
    expect(meta.readTools).toEqual([]);
    expect(ratifiedReadTools({ ...meta, readTools: ["echo_say"] })).toEqual([]);
    expect(requestKindForTool("mcp__telar__echo_say")).toBe("tool_call");
  });
});
