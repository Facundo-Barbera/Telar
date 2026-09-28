import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

export type ToolCost = { fullSchemas: number; fullSchemaBytes: number; deferredNames: number; deferredNameBytes: number; requestBytes: number };

const BYTES_PER_TOKEN = 4.1;
export const approxTokens = (bytes: number): number => Math.round(bytes / BYTES_PER_TOKEN);

type Tool = { name?: string; function?: { name?: string } };
const toolName = (tool: Tool): string => tool.name ?? tool.function?.name ?? "";
const isTelar = (name: string): boolean => /(^|__|^)telar([-_]|$)/.test(name) || name.startsWith("telar");

/** What Telar's own tools add to one captured provider request body (Anthropic, OpenAI chat or Responses). */
export function telarToolCost(body: { tools?: Tool[]; messages?: unknown; input?: unknown }): ToolCost {
  const telar = (body.tools ?? []).filter((tool) => isTelar(toolName(tool)));
  const names = [...new Set(JSON.stringify([body.messages ?? [], body.input ?? []]).match(/mcp__telar[\w-]*__\w+/g) ?? [])];
  return {
    fullSchemas: telar.length,
    fullSchemaBytes: telar.reduce((sum, tool) => sum + JSON.stringify(tool).length, 0),
    deferredNames: names.length,
    deferredNameBytes: names.join("\n").length,
    requestBytes: JSON.stringify(body).length,
  };
}

async function capture(): Promise<void> {
  const { createClaudeDriver } = await import("../src/drivers/claude");
  const { BrowserToolSocket, BROWSER_TOOLS } = await import("../src/domains/browser");
  const { TELAR_ORIENTATION } = await import("../src/domains/sessions");
  const { collectTelarWall, TelarToolSocket, telarWall } = await import("../src/domains/agent-tools");
  const { pluginToolModules } = await import("../src/domains/plugins");

  const out = fs.mkdtempSync(path.join(os.tmpdir(), "telar-tools-cost-"));
  const repo = path.join(out, "repo");
  fs.mkdirSync(repo);
  Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
  const bodies = new Map<string, unknown>();
  let label = "";
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method === "POST" && /messages|responses|completions/.test(request.url ?? "")) {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { tools?: unknown[] };
        if ((body.tools?.length ?? 0) > ((bodies.get(label) as { tools?: unknown[] } | undefined)?.tools?.length ?? -1)) bodies.set(label, body);
      }
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "capture", code: "capture" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const stub = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const withPlugins = process.argv.includes("--plugins");
  const plugins = withPlugins ? Object.fromEntries(pluginToolModules().map((module) => [module.meta.id, {}])) : {};
  const caps = { sessions: {}, notes: {}, prompts: {}, display: {}, run: {}, plugins };
  const telarLease = (await new TelarToolSocket().bind(() => collectTelarWall(telarWall(() => caps))))!;
  const browserLease = await new BrowserToolSocket({ tools: BROWSER_TOOLS, run: async () => ({ content: [] }) } as never).bind({ scopeKey: "cost", sessionId: "cost" } as never);
  const leases = { telar: telarLease, "telar-browser": browserLease };

  const run = async (cmd: string[], env: Record<string, string>) => {
    const child = Bun.spawn(cmd, { cwd: repo, env: { ...process.env, ...env }, stdout: "ignore", stderr: "ignore" });
    await Promise.race([child.exited, Bun.sleep(90_000)]);
    child.kill();
  };

  for (const search of ["true", "false"]) {
    label = `claude (tool search ${search === "true" ? "on" : "off"})`;
    const config = path.join(out, `claude-${search}`);
    fs.mkdirSync(config);
    await createClaudeDriver()
      .run({
        prompt: "hi", sessionId: `session_cost_${search}`, cwd: repo, signal: AbortSignal.timeout(90_000), onObservations: async () => {},
        orientation: TELAR_ORIENTATION, browserSocket: { url: browserLease.url, token: browserLease.token }, ...caps,
        env: { ANTHROPIC_BASE_URL: stub, ANTHROPIC_API_KEY: "sk-capture", CLAUDE_CONFIG_DIR: config, ENABLE_TOOL_SEARCH: search },
      } as never)
      .catch(() => undefined);
  }

  label = "codex";
  const codexHome = path.join(out, "codex");
  fs.mkdirSync(codexHome);
  await run(
    ["codex", "exec", "--skip-git-repo-check", "-c", 'model_provider="stub"', "-c", 'model="gpt-5.5"',
      "-c", `model_providers.stub={name="stub",base_url="${stub}/v1",env_key="STUB_KEY",wire_api="responses"}`,
      ...Object.entries(leases).flatMap(([name, lease]) => ["-c", `mcp_servers.${name}={url="${lease.url}",http_headers={Authorization="Bearer ${lease.token}"}}`]),
      "hi"],
    { CODEX_HOME: codexHome, STUB_KEY: "x" },
  );

  for (const [flavour, npm, suffix] of [["openai", "@ai-sdk/openai-compatible", "/v1"], ["anthropic", "@ai-sdk/anthropic", "/v1"]] as const) {
    label = `opencode (${flavour})`;
    const home = path.join(out, `opencode-${flavour}`);
    const mcp = Object.fromEntries(Object.entries(leases).map(([name, lease]) => [name, { type: "remote", url: lease.url, headers: { Authorization: `Bearer ${lease.token}` }, oauth: false }]));
    const config = { provider: { stub: { npm, options: { baseURL: `${stub}${suffix}`, apiKey: "x" }, models: { m: {} } } }, model: "stub/m", small_model: "stub/m", mcp };
    await run(["opencode", "run", "hi"], {
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      XDG_CONFIG_HOME: path.join(home, "config"), XDG_DATA_HOME: path.join(home, "data"), XDG_STATE_HOME: path.join(home, "state"),
    });
  }

  for (const [name, body] of bodies) {
    const cost = telarToolCost(body as never);
    console.log(
      `${name}: ${cost.fullSchemas} full schemas ≈${approxTokens(cost.fullSchemaBytes)} tok, ${cost.deferredNames} deferred names ≈${approxTokens(cost.deferredNameBytes)} tok, request ≈${approxTokens(cost.requestBytes)} tok`,
    );
  }
  server.close();
  process.exit(0);
}

if (import.meta.main) await capture();
