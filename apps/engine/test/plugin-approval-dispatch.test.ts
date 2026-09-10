/**
 * DOES THE APPROVAL ACTUALLY DECIDE WHETHER A PLUGIN'S WRITE RUNS.
 *
 * `plugin-approval.test.ts` asserts CLASSIFICATION — that both wires call a
 * given tool the same kind. `codex-driver.test.ts` asserts REGISTRATION — that
 * the socket's url reaches `thread/start`. Neither is evidence that a declined
 * plugin write cannot execute anyway, because in neither does the provider ever
 * touch the socket.
 *
 * This file closes that gap. The repo's fake Codex app-server is driven through
 * the `mcp-elicitation-telar-plugins` scenario, which asks for approval and
 * then — ONLY on accept — makes a real `tools/call` against a real
 * `PluginToolSocket` over loopback. The plugin's capability counts how many
 * times it actually ran, so every assertion here is about EXECUTION rather than
 * about cards:
 *
 *   decline           → the capability never runs
 *   accept            → it runs exactly once
 *   acceptForSession  → it runs once (the widening is the engine's to record,
 *                       and Codex is told plain `accept`)
 *
 * ── WHAT THIS PROVES, AND WHAT IT DOES NOT ──────────────────────────────────
 * It proves TELAR'S HALF: that the engine's decision is forwarded, and that a
 * declined decision means the plugin's capability is never invoked. The fixture
 * is the thing that chooses to call the socket only after an accept, so what is
 * under test is the driver→gate→dispatch path, NOT real Codex's behaviour.
 *
 * IT IS NOT EVIDENCE that a real Codex always elicits before executing an MCP
 * tool. Nothing here can establish that — it is a property of the provider, not
 * of this code — and the socket deliberately holds no gate of its own, so if a
 * real provider ever called `tools/call` without eliciting, the wall would
 * serve it. The credential is the only thing standing between an unelicited
 * call and execution. That limit is real and is stated rather than papered over.
 *
 * No paid provider call: the app-server is this repo's own fixture, pinned
 * fail-closed through `CODEX_BIN`, and the plugin is the proof plugin. No token
 * is ever logged.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TELAR_PLUGINS_MCP_SERVER } from "@telar/engine-client";
import { createCodexDriver } from "../src/codex-driver";
import type { DriverRequest } from "../src/driver";
import { helloToolModule } from "../src/plugins/hello";
import { PluginToolSocket } from "../src/plugins/socket";

const FIXTURE = path.join(import.meta.dir, "fixtures", "fake-codex-app-server.mjs");

/**
 * THE FIXTURE IS PINNED THROUGH `CODEX_BIN`, exactly as `codex-driver.test.ts`
 * does it — and it MUST be. `binaryPath` alone let the driver's own resolution
 * find the real `codex` on this machine and spawn it, which is a live provider
 * process this suite has no business starting.
 */
let previousCodexBin: string | undefined;
beforeAll(() => {
  if (!fs.existsSync(FIXTURE)) throw new Error("the fake app-server fixture is missing; refusing to run rather than fall back to a real provider");
  previousCodexBin = process.env.CODEX_BIN;
  process.env.CODEX_BIN = FIXTURE;
});
afterAll(() => {
  if (previousCodexBin === undefined) delete process.env.CODEX_BIN;
  else process.env.CODEX_BIN = previousCodexBin;
});

const sockets: PluginToolSocket[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) await socket.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A capability that COUNTS, so "was it approved" and "did it run" are separable. */
function countingHello() {
  const calls: string[] = [];
  return {
    calls,
    capability: {
      ping: async (input?: { name?: string }) => {
        calls.push(input?.name ?? "world");
        return { greeted: input?.name ?? "world" };
      },
      state: async () => ({ busy: false }),
    },
  };
}

/** One Codex turn through the fixture, with a real plugin socket bound. */
async function turnWithDecision(decision: "accept" | "decline" | "acceptForSession") {
  const { calls, capability } = countingHello();
  const socket = new PluginToolSocket();
  sockets.push(socket);
  const lease = (await socket.bind([helloToolModule], { hello: capability }))!;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-plugin-approve-"));
  dirs.push(dir);

  // FAIL CLOSED. If the pin is ever lost the driver's own resolution will find
  // a real `codex` on the machine and spawn it — which is exactly what happened
  // once while this file was being written. Refusing here is cheap; a live
  // provider process started by a test is not.
  if (process.env.CODEX_BIN !== FIXTURE) throw new Error("CODEX_BIN is not pinned to the fixture; refusing to spawn a provider");

  const asked: DriverRequest[] = [];
  const driver = createCodexDriver({
    env: { FAKE_CODEX_TURN_SCENARIO: "mcp-elicitation-telar-plugins", FAKE_CODEX_PARAMS_LOG: path.join(dir, "params.jsonl") },
  });
  const result = await driver.run({
    prompt: "hi",
    cwd: "/tmp/project",
    signal: new AbortController().signal,
    onObservations: async () => undefined,
    onRequest: async (incoming) => {
      asked.push(incoming);
      return decision;
    },
    pluginsSocket: { url: lease.url, token: lease.token, generation: lease.generation },
  });
  return { calls, asked, result, lease };
}

test("a DECLINED plugin write never runs — the gate decides dispatch, not just the card", async () => {
  const { calls, asked, result } = await turnWithDecision("decline");

  // Exactly one card, classified by the HOST as a tool call — `hello_ping` is
  // not a ratified read, so it parks rather than auto-accepting.
  expect(asked.map((request) => request.kind)).toEqual(["tool_call"]);
  // …and it names the plugin's tool on the shared server key, which is what
  // makes the remembered approval the same one a Claude turn would produce.
  expect(JSON.stringify(asked[0])).toContain("hello_ping");
  expect(JSON.stringify(asked[0])).toContain(TELAR_PLUGINS_MCP_SERVER);

  // And the plugin's capability NEVER RAN. This is the assertion the earlier
  // tests could not make: registering a url proves reachability, not restraint.
  expect(calls).toEqual([]);
  expect(result.text).toContain("decline");
});

test("an ACCEPTED plugin write runs exactly once, through the socket, against that session's capability", async () => {
  const { calls, asked, result } = await turnWithDecision("accept");

  expect(asked).toHaveLength(1);
  // ONE execution, not zero and not two — a double dispatch would be a plugin
  // write happening more often than a person approved it.
  expect(calls).toEqual(["telar"]);
  expect(result.text).toContain("accept");
});

test("acceptForSession runs the write once too — the widening is the engine's to record", async () => {
  // Codex is told plain `accept`; remembering the decision is the engine's job,
  // and it must not turn one approval into two executions.
  const { calls, asked } = await turnWithDecision("acceptForSession");
  expect(asked).toHaveLength(1);
  expect(calls).toEqual(["telar"]);
});

test("the socket refuses a call that arrives without the turn's own bearer", async () => {
  // The other half of "the gate decides": a provider that skipped the
  // elicitation entirely still cannot reach the wall without the credential the
  // driver was handed.
  const { calls, lease } = await turnWithDecision("decline");
  expect(calls).toEqual([]);

  const unauthenticated = await fetch(lease.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "hello_ping", arguments: {} } }),
  });
  expect(unauthenticated.status).toBe(401);
  expect(calls).toEqual([]);
});
