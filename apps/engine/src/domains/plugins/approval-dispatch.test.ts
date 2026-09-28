// A declined plugin write never executes: the fake Codex app-server calls the real socket only
// after an accept. This proves the engine's half, not that a real provider always elicits.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TELAR_MCP_SERVER } from "@telar/engine-client";
import { createCodexDriver } from "../../drivers/codex";
import type { DriverRequest } from "../../drivers";
import { helloToolModule } from "./hello";
import { collectTelarWall, TelarToolSocket } from "../agent-tools";
import { allowCliInThisFile } from "../../../test/allow-cli";

/** NO PROVIDER PROCESS IS SPAWNED HERE, but a binary path IS resolved —
 *  the driver resolves one on its way to the repo’s fake `codex` app-server fixture.
 *  So this file opts past issue #532’s no-spawn gate, for its own scope only.
 *  See ./allow-cli.ts. */
allowCliInThisFile();

const FIXTURE = path.join(import.meta.dir, "../../../test/fixtures", "fake-codex-app-server.mjs");

/**
 * THE FIXTURE IS PINNED THROUGH `CODEX_BIN`, exactly as `drivers/codex/driver.test.ts`
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

const sockets: TelarToolSocket[] = [];
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
  const socket = new TelarToolSocket();
  sockets.push(socket);
  const lease = (await socket.bind(() =>
    collectTelarWall([
      {
        name: "plugin:hello",
        build: ((tool: never, cap: never) => helloToolModule.tools(tool, cap) as unknown[]) as never,
        capability: () => capability,
      },
    ]),
  ))!;

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
    sessionId: "session_one",
    cwd: "/tmp/project",
    signal: new AbortController().signal,
    onObservations: async () => undefined,
    onRequest: async (incoming) => {
      asked.push(incoming);
      return decision;
    },
    telarSocketLease: { url: lease.url, token: lease.token, generation: lease.generation },
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
  expect(JSON.stringify(asked[0])).toContain(TELAR_MCP_SERVER);

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
