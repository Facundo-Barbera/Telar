/**
 * WHAT TELAR ADDS TO A CLAUDE CODE SESSION'S FIRST REQUEST — #563.
 *
 * A fixture turn through the real `createClaudeDriver`, with a fake SDK that
 * records the options the driver would spawn `claude` with: the system-prompt
 * append, the child env and every MCP registration, the in-process `telar`
 * wall captured tool by tool. No CLI, no model, no network.
 *
 * "Bare Claude Code" is the same assembly minus Telar's additions. Both run the
 * `claude_code` preset with the CLI's default setting sources, so the preset,
 * built-in tools, CLAUDE.md, the user's skills and the user's MCP servers are
 * identical and cancel out; only the rows below differ.
 *
 * TOKENS ARE ceil(chars / 4). The repo has no Anthropic tokenizer. JSON schemas
 * tokenize denser than prose — the 24 Sep benchmark measured ~3.2 bytes per
 * token for tool definitions — so the schema rows are a floor, not a ceiling.
 *
 * `mac` (computer use) is an external binary whose schemas are not in the tree:
 * its row uses the benchmark's measured 56 tools / 135,951 B and a 25-char
 * mean name. Its MCP `instructions` block is not measurable offline at all.
 *
 * Run `bun test test/first-request-context.test.ts` to print the table.
 */
import { expect, test } from "bun:test";
import { createClaudeDriver } from "../src/driver";
import { BROWSER_BRIEFING } from "../src/browser/briefing";
import { BROWSER_TOOLS } from "../src/browser/tools";
import { RUN_BRIEFING } from "../src/run/briefing";
import { toolInputSchema } from "../src/mcp-socket";
import { TELAR_ORIENTATION, TELAR_SKILL } from "../src/orientation";
import { parseFrontMatter } from "../src/provider-skills";
import type { DriverRun } from "../src/provider-contract";

const tokens = (chars: number) => Math.ceil(chars / 4);
/** A deferred tool costs its name and a newline. */
const listed = (names: string[]) => names.reduce((sum, name) => sum + name.length + 1, 0);

/** What Claude Code prints ahead of the deferred names (CLI 2.1.x). */
const DEFERRED_HEADER =
  "The following deferred tools are now available via ToolSearch. Their schemas are NOT loaded — calling them directly will fail with InputValidationError. Use ToolSearch with query \"select:<name>[,<name>...]\" to load tool schemas before calling them:\n";

/** From docs/investigations/engine-performance-2026-09-24.md. */
const MAC = { tools: 56, schemaBytes: 135_951, meanNameChars: 25 };

type Captured = { append: string; env: Record<string, string | undefined>; servers: string[]; telar: { name: string; description: string; shape: Record<string, unknown> }[] };

/** A typical project session: orientation on, a browser, a checkout. */
const TELAR_SESSION = {
  orientation: TELAR_ORIENTATION,
  browserSocket: { url: "http://127.0.0.1:1/mcp", token: "t" },
  sessions: {},
  notes: {},
  display: {},
  run: {},
};

/** One cold turn through the real driver; `extra` is what Telar binds on top of a bare spawn. */
async function firstRequest(extra: Record<string, unknown>): Promise<Captured> {
  const telar: Captured["telar"] = [];
  let options: { systemPrompt?: { append?: string }; env?: Record<string, string | undefined>; mcpServers?: Record<string, unknown> } = {};
  const driver = createClaudeDriver(
    async () => ({
      tool: (name: string, description: string, shape: Record<string, unknown>) => {
        telar.push({ name, description, shape });
        return { name };
      },
      createSdkMcpServer: (input: unknown) => input,
      async *query(input: { options: typeof options }) {
        options = input.options;
        yield { type: "result", subtype: "success" };
      },
    }),
    { resolveExecutable: () => "/fake/bin/claude" },
  );
  await driver.run({
    prompt: "fixture",
    sessionId: "session_first_request",
    cwd: "/tmp",
    signal: new AbortController().signal,
    onObservations: async () => {},
    ...extra,
  } as unknown as DriverRun);
  return {
    append: options.systemPrompt?.append ?? "",
    env: options.env ?? {},
    servers: Object.keys(options.mcpServers ?? {}),
    telar,
  };
}

const apiTool = (name: string, description: string, shape: Record<string, unknown>) =>
  JSON.stringify({ name, description, input_schema: toolInputSchema(shape) });

async function measureFirstRequest() {
  const captured = await firstRequest(TELAR_SESSION);
  const telarNames = captured.telar.map((tool) => `mcp__telar__${tool.name}`);
  const browserNames = BROWSER_TOOLS.map((tool) => `mcp__telar-browser__${tool.name}`);
  const skill = parseFrontMatter(TELAR_SKILL);
  const rows = [
    { component: "append: orientation", chars: TELAR_ORIENTATION.length },
    { component: "append: browser briefing", chars: BROWSER_BRIEFING.length },
    { component: "append: run briefing", chars: RUN_BRIEFING.length },
    { component: "append: separators", chars: captured.append.length - TELAR_ORIENTATION.length - BROWSER_BRIEFING.length - RUN_BRIEFING.length },
    { component: "deferred-tools header", chars: DEFERRED_HEADER.length },
    { component: `telar tool names (${telarNames.length}, deferred)`, chars: listed(telarNames) },
    { component: `telar-browser tool names (${browserNames.length}, deferred)`, chars: listed(browserNames) },
    { component: `mac tool names (${MAC.tools}, deferred, external est.)`, chars: MAC.tools * (MAC.meanNameChars + 1) },
    { component: "telar skill listing line", chars: `- ${skill.name}: ${skill.description}\n`.length },
  ];
  const schemas = {
    telar: captured.telar.reduce((sum, tool) => sum + apiTool(`mcp__telar__${tool.name}`, tool.description, tool.shape).length, 0),
    browser: BROWSER_TOOLS.reduce(
      (sum, tool) => sum + apiTool(`mcp__telar-browser__${tool.name}`, tool.description, (tool.input as { shape: Record<string, unknown> }).shape).length,
      0,
    ),
    mac: MAC.schemaBytes,
  };
  const total = rows.reduce((sum, row) => sum + row.chars, 0);
  return { captured, rows, total, schemas };
}

test("a bare spawn through the same driver adds nothing Claude Code would not send on its own", async () => {
  const bare = await firstRequest({});
  expect(bare.append).toBe("");
  expect(bare.servers).toEqual([]);
  expect(bare.telar).toEqual([]);
});

test("the fixture's first request carries only names for Telar's MCP tools, and the Telar-added context stays pinned", async () => {
  const { captured, rows, total, schemas } = await measureFirstRequest();
  console.table([
    ...rows.map((row) => ({ ...row, tokens: tokens(row.chars), bare: 0 })),
    { component: "TOTAL Telar-added, first call", chars: total, tokens: tokens(total), bare: 0 },
  ]);
  const undeferred = schemas.telar + schemas.browser + schemas.mac;
  console.table([
    { component: "telar schemas, if not deferred", chars: schemas.telar, tokens: tokens(schemas.telar) },
    { component: "telar-browser schemas, if not deferred", chars: schemas.browser, tokens: tokens(schemas.browser) },
    { component: "mac schemas, if not deferred (benchmark)", chars: schemas.mac, tokens: tokens(schemas.mac) },
    { component: "TOTAL avoided by tool search", chars: undeferred, tokens: tokens(undeferred) },
  ]);

  // Deferral is what keeps the schemas out; without it every row above is a schema.
  expect(captured.env.ENABLE_TOOL_SEARCH).toBe("true");
  expect(captured.servers).toEqual(["telar-browser", "telar"]);
  expect(captured.append).toBe([TELAR_ORIENTATION, BROWSER_BRIEFING, RUN_BRIEFING].join("\n\n"));
  // The wall really was captured, so the name rows are not vacuously small.
  expect(captured.telar.length).toBeGreaterThan(30);
  expect(schemas.telar).toBeGreaterThan(10 * listed(captured.telar.map((tool) => tool.name)));
  // Ceiling on everything Telar adds before the person's first word.
  expect(total).toBeLessThan(10_000);
});
