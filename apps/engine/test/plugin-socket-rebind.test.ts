/**
 * WHAT HAPPENS TO A LIVE PROVIDER WHEN A PROJECT CHANGES WHICH PLUGINS ARE ON.
 *
 * This file exists because the first draft of the plugin socket got it wrong in
 * a way that nothing else caught. Every binding shares ONE listener and
 * therefore one url; the driver fingerprint held that url; so going from
 * enabled-set A to a different non-empty set B rebound the socket — revoking
 * A's token — while leaving the fingerprint unchanged. The provider kept the
 * query it was started with, whose Authorization header was now dead, and every
 * plugin call 401'd.
 *
 * The three properties that make that impossible are asserted here against a
 * REAL worker driving a REAL socket over loopback:
 *
 *   A → B      rebinds, the new credential works, and the OLD bearer is refused
 *   A → A      does not rebind, so a reused query keeps working
 *   A → B      moves the driver's fingerprint, so a Claude query cold-starts
 *              onto the new credential instead of holding the revoked one
 *
 * Temp engine root, temp project. No real home, no provider process, no token
 * is ever logged.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient, PLUGIN_API_VERSION, type PluginMeta } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../src/daemon";
import { createClaudeDriver, type DriverRun, type TurnDriver } from "../src/driver";
import { setPluginToolModules } from "../src/plugins/bundled";
import { helloToolModule } from "../src/plugins/hello";
import type { PluginToolModule } from "../src/plugins/tool-module";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-plugin-rebind-"));
  roots.push(directory);
  return directory;
};

afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  setPluginToolModules([]);
});

/**
 * A SECOND WALL, so the enabled SET can change rather than merely emptying.
 * Emptying is the easy case — the socket is dropped entirely — and it is not
 * the case that broke.
 */
const secondMeta: PluginMeta = {
  id: "second",
  api: PLUGIN_API_VERSION,
  name: "Second",
  version: "1.0.0",
  toolPrefixes: ["second"],
  readTools: [],
  eventKinds: [],
  settings: [],
};
const secondModule: PluginToolModule = {
  meta: secondMeta,
  capability: () => ({}),
  tools: (tool) => [tool("second_noop", "A second wall, so the enabled set can change.", {}, async () => ({ content: [{ type: "text", text: "ok" }] }))],
};

/** Records what each turn's driver was handed, without ever storing a token. */
function recordingDriver(): { driver: TurnDriver; sockets: { url: string; token: string; generation: string }[] } {
  const sockets: { url: string; token: string; generation: string }[] = [];
  return {
    sockets,
    driver: {
      run: async ({ prompt, pluginsSocket }: DriverRun) => {
        if (pluginsSocket) sockets.push(pluginsSocket);
        return { text: `echo:${prompt}` };
      },
    },
  };
}

async function eventually(assertion: () => void | Promise<void>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
  throw last;
}

/** `tools/list` over the socket, exactly as a provider asks. */
async function list(lease: { url: string; token: string }) {
  const response = await fetch(lease.url, {
    method: "POST",
    headers: { authorization: `Bearer ${lease.token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const body = (await response.json()) as { result?: { tools?: { name: string }[] } };
  return { status: response.status, names: (body.result?.tools ?? []).map((tool) => tool.name) };
}

test("changing the enabled set rebinds: the new credential works and the old bearer is refused", async () => {
  setPluginToolModules([helloToolModule, secondModule]);
  const { driver, sockets } = recordingDriver();
  const daemon = await startEngine({
    engineRoot: root(),
    workerLeaseMs: 5_000,
    embeddedWorker: { createDriver: () => driver, pollMs: 20 },
  });
  daemons.push(daemon);

  const client = new EngineClient(daemon.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: root() });
  await client.updateProject("project_one", { plugins: { hello: { enabled: true } } });
  await client.createSession({ id: "session_one", projectId: "project_one" });

  // ── set A ────────────────────────────────────────────────────────────────
  await client.submitTurn("session_one", { runId: "run_a", input: "one" });
  await eventually(() => expect(sockets).toHaveLength(1));
  const leaseA = sockets[0]!;
  expect((await list(leaseA)).names).toEqual(["hello_ping", "hello_state"]);

  // ── set B: a DIFFERENT non-empty set, which is the case that broke ───────
  await client.updateProject("project_one", { plugins: { second: { enabled: true } } });
  await client.submitTurn("session_one", { runId: "run_b", input: "two" });
  await eventually(() => expect(sockets).toHaveLength(2));
  const leaseB = sockets[1]!;

  // The lease is a NEW one, and says so in a way a fingerprint can hold.
  expect(leaseB.generation).not.toBe(leaseA.generation);
  // …which it has to, because the url alone cannot tell them apart.
  expect(leaseB.url).toBe(leaseA.url);

  // The new credential serves the new wall.
  const listedB = await list(leaseB);
  expect(listedB.status).toBe(200);
  expect(listedB.names).toEqual(["hello_ping", "hello_state", "second_noop"]);

  // …and the OLD bearer is dead. This is the whole point: a provider still
  // holding it must fail loudly rather than serve a plugin that was turned off.
  expect((await list(leaseA)).status).toBe(401);
});

test("an unchanged enabled set does NOT rebind, so a reused query keeps working", async () => {
  setPluginToolModules([helloToolModule, secondModule]);
  const { driver, sockets } = recordingDriver();
  const daemon = await startEngine({
    engineRoot: root(),
    workerLeaseMs: 5_000,
    embeddedWorker: { createDriver: () => driver, pollMs: 20 },
  });
  daemons.push(daemon);

  const client = new EngineClient(daemon.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: root() });
  await client.updateProject("project_one", { plugins: { hello: { enabled: true } } });
  await client.createSession({ id: "session_one", projectId: "project_one" });

  await client.submitTurn("session_one", { runId: "run_1", input: "one" });
  await eventually(() => expect(sockets).toHaveLength(1));
  await client.submitTurn("session_one", { runId: "run_2", input: "two" });
  await eventually(() => expect(sockets).toHaveLength(2));

  // SAME lease across both turns — rebinding here would revoke a credential the
  // provider is still holding, for no reason at all.
  expect(sockets[1]!.generation).toBe(sockets[0]!.generation);
  expect(sockets[1]!.token).toBe(sockets[0]!.token);
  expect((await list(sockets[0]!)).status).toBe(200);
});

test("a new lease moves the driver's fingerprint, so a live Claude query cold-starts onto it", async () => {
  // The other half of the fix. The worker revokes the old token; this is what
  // guarantees the provider is rebuilt rather than left holding it.
  const seen: { queryCalls: number } = { queryCalls: 0 };
  const driver = createClaudeDriver(async () => ({
    tool: (name: string) => ({ name }),
    createSdkMcpServer: (input: unknown) => input,
    async *query(input: { prompt: AsyncIterable<unknown> }) {
      seen.queryCalls += 1;
      for await (const message of input.prompt) {
        void message;
        yield { type: "result", subtype: "success" };
      }
    },
  }));

  const turn = (generation: string) =>
    driver.run({
      prompt: "prompt",
      sessionId: "session_fingerprint",
      cwd: "/tmp",
      signal: new AbortController().signal,
      onObservations: async () => undefined,
      // Same url every time — one listener, many leases. Only the generation
      // distinguishes them, which is exactly the bug this pins.
      pluginsSocket: { url: "http://127.0.0.1:9/v2/plugins/mcp", token: "irrelevant", generation },
    });

  await turn("g1");
  expect(seen.queryCalls).toBe(1);
  // Same lease: reuse.
  await turn("g1");
  expect(seen.queryCalls).toBe(1);
  // A rebind: the old token is revoked, so the query MUST be rebuilt.
  await turn("g2");
  expect(seen.queryCalls).toBe(2);
});
