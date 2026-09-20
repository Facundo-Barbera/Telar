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
import { createClaudeDriver } from "../src/driver";
import type { DriverRun, TurnDriver } from "../src/provider-contract";
import { TelarToolSocket } from "../src/telar-socket";
import { setPluginToolModules } from "../src/plugins/bundled";
import { helloToolModule } from "../src/plugins/hello";
import type { PluginToolModule } from "../src/plugins/tool-module";
import { stubModels } from "./stub-models";
import { allowCliInThisFile, pinFakeClaudeInThisFile } from "./allow-cli";

/** NO PROVIDER PROCESS IS SPAWNED HERE, but a binary path IS resolved —
 *  its daemon's Claude driver resolves one before every claim, against stubbed models.
 *  So this file opts past issue #532’s no-spawn gate, for its own scope only.
 *  See ./allow-cli.ts. */
allowCliInThisFile();
/** And pin WHICH claude, so the resolve cannot depend on this machine (#752). */
pinFakeClaudeInThisFile();

const roots: string[] = [];
const daemons: EngineDaemon[] = [];
const telarSockets: TelarToolSocket[] = [];
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-plugin-rebind-"));
  roots.push(directory);
  return directory;
};

afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const socket of telarSockets.splice(0)) await socket.close();
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
function recordingDriver(options: {
  /** Dispatched over the lease WHILE the turn is live, as a provider would. */
  duringTurn?: (lease: { url: string; token: string }, prompt: string) => Promise<void>;
  /**
   * Which turns this driver is the SUBJECT of — matched on the prompt.
   *
   * Since #631 part 2 a `sessions_send` to an idle session starts a turn there,
   * so the recipient runs through this same embedded worker and would otherwise
   * be counted among the sockets under test — and, worse, its own `duringTurn`
   * would send again, to itself, without end. The subject here is the SENDER's
   * lease across its two turns; the recipient's turns are real and are supposed
   * to happen, they are just not what is being measured.
   */
  subject?: (prompt: string) => boolean;
} = {}): { driver: TurnDriver; sockets: { url: string; token: string; generation: string }[] } {
  const sockets: { url: string; token: string; generation: string }[] = [];
  const isSubject = options.subject ?? (() => true);
  return {
    sockets,
    driver: {
      run: async ({ prompt, telarSocketLease }: DriverRun) => {
        if (telarSocketLease && isSubject(prompt)) sockets.push(telarSocketLease);
        if (telarSocketLease && isSubject(prompt) && options.duringTurn) await options.duringTurn(telarSocketLease, prompt);
        return { text: `echo:${prompt}` };
      },
    },
  };
}

async function eventually(assertion: () => void | Promise<void>, timeoutMs = 15_000): Promise<void> {
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

/** `tools/call` over the socket, exactly as a provider dispatches. */
async function call(lease: { url: string; token: string }, name: string, args: Record<string, unknown>) {
  const response = await fetch(lease.url, {
    method: "POST",
    headers: { authorization: `Bearer ${lease.token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }),
  });
  return (await response.json()) as { result?: { isError?: boolean; content?: { text?: string }[] } };
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
  const daemon = await startEngine({ models: stubModels,
    engineRoot: root(),
    workerLeaseMs: 5_000,
    embeddedWorker: { createDriver: () => driver, pollMs: 20 },
  });
  daemons.push(daemon);

  const client = new EngineClient(daemon.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: root() });
  await client.updateProject("project_one", { plugins: { hello: { enabled: true } } });
  // A CODEX session: the worker owns the lease for providers that take MCP
  // servers as config. Claude's driver binds its own — covered separately below.
  await client.createSession({ id: "session_one", projectId: "project_one", driver: "codex" });

  // ── set A ────────────────────────────────────────────────────────────────
  await client.submitTurn("session_one", { runId: "run_a", input: "one" });
  await eventually(() => expect(sockets).toHaveLength(1));
  const leaseA = sockets[0]!;
  // The `telar` wall carries the core toolkits too, so assert the plugin's
  // presence rather than exclusivity.
  expect((await list(leaseA)).names).toEqual(expect.arrayContaining(["hello_ping", "hello_state"]));

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
  expect(listedB.names).toEqual(expect.arrayContaining(["hello_ping", "hello_state", "second_noop"]));

  // …and the OLD bearer is dead. This is the whole point: a provider still
  // holding it must fail loudly rather than serve a plugin that was turned off.
  expect((await list(leaseA)).status).toBe(401);
});

test("an unchanged enabled set does NOT rebind, so a reused query keeps working", async () => {
  setPluginToolModules([helloToolModule, secondModule]);
  const { driver, sockets } = recordingDriver();
  const daemon = await startEngine({ models: stubModels,
    engineRoot: root(),
    workerLeaseMs: 5_000,
    embeddedWorker: { createDriver: () => driver, pollMs: 20 },
  });
  daemons.push(daemon);

  const client = new EngineClient(daemon.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: root() });
  await client.updateProject("project_one", { plugins: { hello: { enabled: true } } });
  // A CODEX session: the worker owns the lease for providers that take MCP
  // servers as config. Claude's driver binds its own — covered separately below.
  await client.createSession({ id: "session_one", projectId: "project_one", driver: "codex" });

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

test("a REUSED lease serves the current turn's capabilities, not the ones it was minted under", async () => {
  /**
   * The credential is reused across turns; the capabilities behind it are NOT.
   * `sessionsCapability` closes over this turn's `runId` and `claimToken` — it
   * stamps them onto every `sessions_send` as proof of who is speaking. A wall
   * still holding what it was minted with would sign turn two's message with
   * turn one's spent claim, and the engine refuses it as arriving after the
   * turn ended: the session quietly stops being able to message anyone after
   * its first turn.
   *
   * Dispatched WHILE each turn is live, which is the only moment the proof is
   * meaningful.
   */
  setPluginToolModules([helloToolModule]);
  const sends: { prompt: string; error: boolean; text: string }[] = [];
  const { driver, sockets } = recordingDriver({
    // Only `session_one`'s own two turns; `session_two` now runs a turn for each
    // message it receives, and those are not the lease under test.
    subject: (prompt) => prompt === "one" || prompt === "two",
    duringTurn: async (lease, prompt) => {
      const sent = await call(lease, "sessions_send", { sessionId: "session_two", input: prompt });
      sends.push({
        prompt,
        error: sent.result?.isError ?? false,
        text: sent.result?.content?.[0]?.text ?? "",
      });
    },
  });
  const daemon = await startEngine({ models: stubModels,
    engineRoot: root(),
    workerLeaseMs: 5_000,
    embeddedWorker: { createDriver: () => driver, pollMs: 20 },
  });
  daemons.push(daemon);

  const client = new EngineClient(daemon.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: root() });
  await client.updateProject("project_one", { plugins: { hello: { enabled: true } } });
  await client.createSession({ id: "session_one", projectId: "project_one", driver: "codex" });
  await client.createSession({ id: "session_two", projectId: "project_one", driver: "codex" });

  await client.submitTurn("session_one", { runId: "run_1", input: "one" });
  await eventually(() => expect(sockets).toHaveLength(1));
  await client.submitTurn("session_one", { runId: "run_2", input: "two" });
  await eventually(() => expect(sockets).toHaveLength(2));

  // The enabled plugin set did not change, so the credential did not either.
  expect(sockets[1]!.token).toBe(sockets[0]!.token);
  // Both turns spoke, and the second was not signed with the first's claim.
  await eventually(() => expect(sends).toHaveLength(2));
  expect(sends.map((send) => `${send.prompt}:${send.error}`)).toEqual(["one:false", "two:false"]);
  expect(sends[1]!.text).not.toContain("already settled");
});

test("a DRIVER-owned lease cold-starts the Claude query when the enabled set changes", async () => {
  /**
   * The other half of the rebind story. Claude's driver binds its own telar
   * socket, so its fingerprint keys on the lease that socket minted — a set
   * change must rebuild the query, and an unchanged set must reuse it.
   */
  setPluginToolModules([helloToolModule, secondModule]);
  const socket = new TelarToolSocket();
  telarSockets.push(socket);

  const seen = { queryCalls: 0 };
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

  const hello = { ping: async () => ({ greeted: "world" }), state: async () => ({ busy: false }) };
  const turn = (plugins: Record<string, unknown>) =>
    driver.run({
      prompt: "prompt",
      sessionId: "session_driver_lease",
      cwd: "/tmp",
      signal: new AbortController().signal,
      onObservations: async () => undefined,
      telarSocket: socket,
      plugins,
    });

  await turn({ hello });
  expect(seen.queryCalls).toBe(1);
  // Same set: the lease is reused and so is the query.
  await turn({ hello });
  expect(seen.queryCalls).toBe(1);
  // A changed set rebinds, which moves the fingerprint and rebuilds the query.
  await turn({ hello, second: {} });
  expect(seen.queryCalls).toBe(2);
});
