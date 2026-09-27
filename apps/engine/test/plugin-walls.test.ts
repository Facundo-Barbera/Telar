/**
 * DATA SCIENCE AND LATEX, REGISTERED THROUGH THE PLUGIN HOST — the invariants
 * that moving them off hand-written registration must not break.
 *
 *   names       every path offers exactly the tools the old hand-written
 *               registration offered (`dsTools` + `notebookTools`, `latexTools`),
 *               under the `telar` key, so `mcp__telar__ds_*` and every stored
 *               approval keep their identity
 *   disabled    a plugin the project did not enable contributes no tools
 *   worker      Codex/OpenCode still get the walls through the worker's lease
 *   briefing    a plugin's paragraph reaches a session only when it is enabled
 *
 * Temp engine root, temp projects, fake SDK. No provider process runs.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient, TELAR_MCP_SERVER, canonicalToolName } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../src/daemon";
import { createClaudeDriver } from "../src/driver";
import type { DriverRun, TurnDriver } from "../src/provider-contract";
import { TelarToolSocket } from "../src/telar-socket";
import { bundledPluginToolModules, pluginBriefings, setPluginToolModules } from "../src/plugins/bundled";
import { dataScienceMeta } from "../src/plugins/data-science";
import { latexMeta } from "../src/plugins/latex";
import { openCodeBriefings } from "../src/opencode/runtime";
import { dsTools } from "../src/ds/ds-tools";
import { notebookTools } from "../src/ds/notebook-tools";
import { latexTools } from "../src/latex/latex-tools";
import type { ToolFactory } from "../src/tool-kit";
import { TELAR_SKILL } from "../src/orientation";
import { stubModels } from "./stub-models";
import { allowCliInThisFile, pinFakeClaudeInThisFile } from "./allow-cli";

allowCliInThisFile();
pinFakeClaudeInThisFile();

const roots: string[] = [];
const daemons: EngineDaemon[] = [];
const sockets: TelarToolSocket[] = [];
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-plugin-walls-"));
  roots.push(directory);
  return directory;
};

beforeEach(() => setPluginToolModules(bundledPluginToolModules({})));
afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const socket of sockets.splice(0)) await socket.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  setPluginToolModules(bundledPluginToolModules());
});

/** The names a builder registers, read off a recording factory. */
function namesOf(...builders: ((tool: ToolFactory, capability: never) => unknown[])[]): string[] {
  const names: string[] = [];
  const record: ToolFactory = (name) => {
    names.push(name);
    return null;
  };
  const capability = new Proxy({}, { get: () => () => undefined }) as never;
  for (const build of builders) build(record, capability);
  return names.sort();
}

/** What the hand-written registration offered, before the move. */
const DS_NAMES = namesOf(notebookTools, dsTools);
const LATEX_NAMES = namesOf(latexTools);
const PLUGIN_PREFIX = /^(ds|notebook|latex)_/;
const pluginNames = (names: string[]) => names.filter((name) => PLUGIN_PREFIX.test(name)).sort();

const CASES = [
  { label: "data science on", plugins: ["data-science"], expected: DS_NAMES },
  { label: "latex on", plugins: ["latex"], expected: LATEX_NAMES },
  { label: "both on", plugins: ["data-science", "latex"], expected: [...DS_NAMES, ...LATEX_NAMES].sort() },
  { label: "both off", plugins: [], expected: [] },
] as const;

/** A capability object per enabled id; its methods are never called here. */
const capabilities = (ids: readonly string[]) => Object.fromEntries(ids.map((id) => [id, {}]));

test("the baseline is what shipped: the tool names are the `mcp__telar__` ones approvals are stored under", () => {
  expect(DS_NAMES).toContain("ds_kernel");
  expect(DS_NAMES).toContain("notebook_run_cell");
  expect(LATEX_NAMES).toContain("latex_compile");
  expect(canonicalToolName(TELAR_MCP_SERVER, "ds_kernel")).toBe("mcp__telar__ds_kernel");
});

/** One Claude turn against a fake SDK; returns what the query was started with. */
async function claudeTurn(plugins: Record<string, unknown>, socket?: TelarToolSocket) {
  let captured: { servers?: Record<string, { tools?: { name: string }[]; url?: string; headers?: Record<string, string> }>; append?: string } = {};
  const driver = createClaudeDriver(
    async () => ({
      tool: (name: string) => ({ name }),
      createSdkMcpServer: (input: { tools: { name: string }[] }) => ({ tools: input.tools }),
      async *query(input: { options: { mcpServers?: Record<string, never>; systemPrompt?: { append?: string } } }) {
        captured = {
          ...(input.options.mcpServers ? { servers: input.options.mcpServers } : {}),
          ...(input.options.systemPrompt?.append ? { append: input.options.systemPrompt.append } : {}),
        };
        yield { type: "result", subtype: "success" };
      },
    }),
    { resolveExecutable: () => "/fake/bin/claude" },
  );
  await driver.run({
    prompt: "prompt",
    sessionId: `session_${Math.random().toString(36).slice(2)}`,
    cwd: "/tmp",
    signal: new AbortController().signal,
    onObservations: async () => undefined,
    ...(socket ? { telarSocket: socket } : {}),
    ...(Object.keys(plugins).length > 0 ? { plugins } : {}),
  } as DriverRun);
  return captured;
}

async function advertised(entry: { url: string; headers: Record<string, string> }): Promise<string[]> {
  const response = await fetch(entry.url, {
    method: "POST",
    headers: { ...entry.headers, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const body = (await response.json()) as { result?: { tools?: { name: string }[] } };
  return (body.result?.tools ?? []).map((tool) => tool.name);
}

for (const scenario of CASES) {
  test(`Claude in-process, ${scenario.label}: the same tool names under the \`telar\` key`, async () => {
    const { servers } = await claudeTurn(capabilities(scenario.plugins));
    const inProcess = (servers?.[TELAR_MCP_SERVER]?.tools ?? []).map((tool) => tool.name);
    expect(pluginNames(inProcess)).toEqual([...scenario.expected]);
  });

  test(`Claude over the \`telar\` socket, ${scenario.label}: the same tool names`, async () => {
    const socket = new TelarToolSocket();
    sockets.push(socket);
    const { servers } = await claudeTurn(capabilities(scenario.plugins), socket);
    const entry = servers?.[TELAR_MCP_SERVER] as { url: string; headers: Record<string, string> } | undefined;
    // "Both off" on a turn with no other toolkit binds no socket at all.
    const names = entry ? await advertised(entry) : [];
    expect(pluginNames(names)).toEqual([...scenario.expected]);
  });

  test(`briefings, ${scenario.label}: a plugin's paragraph only where it is enabled`, async () => {
    const { append } = await claudeTurn(capabilities(scenario.plugins));
    const opencode = openCodeBriefings({ plugins: capabilities(scenario.plugins) } as unknown as DriverRun);
    for (const meta of [dataScienceMeta, latexMeta]) {
      const on = scenario.plugins.includes(meta.id as never);
      expect(append?.includes(meta.briefing!) ?? false).toBe(on);
      expect(opencode.includes(meta.briefing!)).toBe(on);
    }
  });
}

test("the skill installed on every machine no longer hardcodes either plugin's tools", () => {
  expect(TELAR_SKILL).not.toContain("ds_*");
  expect(TELAR_SKILL).not.toContain("latex_*");
  expect(pluginBriefings([])).toEqual([]);
});

/** Records each Codex turn's lease and inputs, keyed by session. */
function recordingDriver(): { driver: TurnDriver; runs: Map<string, DriverRun> } {
  const runs = new Map<string, DriverRun>();
  return {
    runs,
    driver: {
      run: async (input: DriverRun) => {
        runs.set(input.sessionId, input);
        return { text: "ok" };
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

test("the worker path: Codex gets exactly the enabled walls on its lease, and the matching briefings", async () => {
  const { driver, runs } = recordingDriver();
  const daemon = await startEngine({
    models: stubModels,
    engineRoot: root(),
    workerLeaseMs: 5_000,
    embeddedWorker: { createDriver: () => driver, pollMs: 20 },
  });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);

  const python = { source: "chosen" as const, path: "/bin/ls", resolvedAt: Date.now() };
  const toolchain = { kind: "texlive", path: "/bin/echo" };
  const setups: Record<string, { patch: Record<string, unknown>; expected: readonly string[]; plugins: string[] }> = {
    ds: { patch: { dataScience: { enabled: true, python } }, expected: DS_NAMES, plugins: ["data-science"] },
    latex: { patch: { latex: { enabled: true, toolchain } }, expected: LATEX_NAMES, plugins: ["latex"] },
    both: {
      patch: { dataScience: { enabled: true, python }, latex: { enabled: true, toolchain } },
      expected: [...DS_NAMES, ...LATEX_NAMES].sort(),
      plugins: ["data-science", "latex"],
    },
    off: { patch: {}, expected: [], plugins: [] },
  };

  for (const [key, setup] of Object.entries(setups)) {
    await client.registerProject({ id: `project_${key}`, name: key, root: root() });
    if (Object.keys(setup.patch).length > 0) await client.updateProject(`project_${key}`, setup.patch as never);
    await client.createSession({ id: `session_${key}`, projectId: `project_${key}`, driver: "codex" });
    await client.submitTurn(`session_${key}`, { runId: `run_${key}`, input: "go" });
  }
  await eventually(() => expect(runs.size).toBe(Object.keys(setups).length));

  for (const [key, setup] of Object.entries(setups)) {
    const run = runs.get(`session_${key}`)!;
    expect(Object.keys(run.plugins ?? {}).sort()).toEqual(setup.plugins);
    // The lease exists in every case: the core toolkits (sessions, run) are on it.
    const lease = run.telarSocketLease!;
    const names = await advertised({ url: lease.url, headers: { authorization: `Bearer ${lease.token}` } });
    expect(pluginNames(names)).toEqual([...setup.expected]);
    const briefings = openCodeBriefings(run);
    expect(briefings.includes(dataScienceMeta.briefing!)).toBe(setup.plugins.includes("data-science"));
    expect(briefings.includes(latexMeta.briefing!)).toBe(setup.plugins.includes("latex"));
  }
});
