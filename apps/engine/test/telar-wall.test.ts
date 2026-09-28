/**
 * ONE `telar` WALL, EVERY PROVIDER. The worker hands Claude the capabilities
 * (registered in-process via `toSdkTools`) and hands Codex and OpenCode a
 * lease on the socket (`collectTelarWall`); both come from `telarWall`, so the
 * advertised names must be the same set on all three.
 *
 * The regressions this pins: Claude lost `prompt_*` (the worker never passed
 * prompts to the driver), Codex and OpenCode lost `display_*` (the socket's
 * copy of the parts list had no display entry), and Codex and OpenCode saw
 * `sessions_*` twice (once on `telar`, once on a per-run `telar-sessions`).
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient, TELAR_MCP_SERVER, canonicalToolName } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../src/daemon";
import type { DriverRun, TurnDriver } from "../src/provider-contract";
import { collectTelarWall, telarWall, toSdkTools, type TelarCapabilities } from "../src/telar-socket";
import type { ToolFactory } from "../src/tool-kit";
import { stubModels } from "./stub-models";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-wall-"));
  roots.push(directory);
  return directory;
};
afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function eventually(assertion: () => void, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return assertion();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
}

/** The names Claude's in-process server would register for this run. */
function claudeNames(run: DriverRun): string[] {
  const tool = ((name: string) => ({ name })) as unknown as ToolFactory;
  return (toSdkTools(telarWall(() => run as TelarCapabilities), tool) as { name: string }[]).map((entry) => entry.name);
}

/** What the lease advertises over the wire, as Codex and OpenCode see it. */
async function leaseNames(run: DriverRun): Promise<string[]> {
  const lease = run.telarSocketLease!;
  const response = await fetch(lease.url, {
    method: "POST",
    headers: { authorization: `Bearer ${lease.token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const body = (await response.json()) as { result: { tools: { name: string }[] } };
  return body.result.tools.map((entry) => entry.name);
}

test("Claude, Codex and OpenCode are handed the same `telar` wall, once", async () => {
  const runs = new Map<string, DriverRun>();
  const driver: TurnDriver = {
    run: async (input) => {
      runs.set(input.sessionId, input);
      return { text: "ok" };
    },
  };
  const daemon = await startEngine({
    models: stubModels,
    engineRoot: root(),
    workerLeaseMs: 5_000,
    embeddedWorker: { createDriver: () => driver, pollMs: 20 },
  });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  daemon.store.saveProviderInstance({ id: "opencode", driver: "opencode", enabled: true });
  await client.registerProject({ id: "project_wall", name: "wall", root: root() });
  const providers = ["claude", "codex", "opencode"] as const;
  for (const provider of providers) {
    await client.createSession({ id: `session_${provider}`, projectId: "project_wall", driver: provider });
    await client.submitTurn(`session_${provider}`, { runId: `run_${provider}`, input: "go" });
  }
  await eventually(() => expect(runs.size).toBe(providers.length));

  const claude = runs.get("session_claude")!;
  expect(claude.telarSocketLease).toBeUndefined();
  const expected = claudeNames(claude);
  expect(expected.some((name) => name.startsWith("prompt_"))).toBe(true);
  expect(expected.some((name) => name.startsWith("display_"))).toBe(true);
  expect(expected.some((name) => name.startsWith("sessions_"))).toBe(true);
  expect(new Set(expected).size).toBe(expected.length);

  for (const provider of ["codex", "opencode"] as const) {
    const run = runs.get(`session_${provider}`)!;
    // No second sessions server beside `telar`.
    expect("sessionsSocket" in run).toBe(false);
    const names = await leaseNames(run);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual([...expected].sort());
  }
  // Every one ships under the key its approvals are stored under.
  for (const name of expected) expect(canonicalToolName(TELAR_MCP_SERVER, name)).toBe(`mcp__telar__${name}`);
});

test("the socket and the in-process transports collect the same list from the same capabilities", () => {
  const capability = new Proxy({}, { get: () => () => undefined });
  const caps: TelarCapabilities = { sessions: capability, notes: capability, prompts: capability, display: capability, run: capability };
  const tool = ((name: string) => ({ name })) as unknown as ToolFactory;
  const inProcess = (toSdkTools(telarWall(() => caps), tool) as { name: string }[]).map((entry) => entry.name);
  const socket = collectTelarWall(telarWall(() => caps)).map((entry) => entry.name);
  expect(inProcess).toEqual(socket);
  expect(collectTelarWall(telarWall(() => ({})))).toEqual([]);
});
