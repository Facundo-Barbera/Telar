import { afterEach, expect, test } from "bun:test";
import { BROWSER_TOOLS } from "../browser/tools";
import { bundledPluginToolModules, pluginToolModules, setPluginToolModules } from "../plugins";
import { collectTelarWall, handleSocketMessage, type TelarCapabilities, telarWall, toolInputSchema, type ToolFactory, toSdkTools } from ".";

const SERVER = { name: "telar", version: "test" };
const original = pluginToolModules();
afterEach(() => setPluginToolModules(original));

function recordingCaps(): { caps: TelarCapabilities; calls: string[] } {
  const calls: string[] = [];
  const capability = new Proxy({}, { get: (_, prop) => (...args: unknown[]) => { calls.push(String(prop)); return Promise.resolve({ args }); } });
  setPluginToolModules(bundledPluginToolModules({ TELAR_PLUGIN_HELLO: "1" }));
  const plugins = Object.fromEntries(pluginToolModules().map((module) => [module.meta.id, capability]));
  return { caps: { sessions: capability, notes: capability, prompts: capability, display: capability, run: capability, plugins }, calls };
}

async function socketCall(caps: TelarCapabilities, name: string, args: unknown) {
  const answer = (await handleSocketMessage(collectTelarWall(telarWall(() => caps)), { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, SERVER)) as {
    result?: { content: { text: string }[]; isError?: boolean };
  };
  return answer.result!;
}

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;

function sdkHandler(caps: TelarCapabilities, name: string): Handler {
  const handlers = new Map<string, Handler>();
  const tool = ((toolName: string, _d: string, _s: unknown, handler: Handler) => handlers.set(toolName, handler)) as unknown as ToolFactory;
  toSdkTools(telarWall(() => caps), tool);
  return handlers.get(name)!;
}

test("an unknown argument is refused over the socket, naming it and the accepted ones, and nothing runs", async () => {
  const { caps, calls } = recordingCaps();
  const result = await socketCall(caps, "sessions_create", { projectId: "p", envMode: "worktree", tasks2: [] });
  expect(result.isError).toBe(true);
  expect(result.content[0]!.text).toStartWith("sessions_create does not take `tasks2`. It takes: projectId, ");
  expect(result.content[0]!.text).toContain("tasks");
  expect(calls).toEqual([]);
});

test("an unknown argument is refused in-process too, and nothing runs", async () => {
  const { caps, calls } = recordingCaps();
  const result = await sdkHandler(caps, "sessions_send")({ sessionId: "s", input: "hi", urgent: true });
  expect(result.isError).toBe(true);
  expect(result.content[0]!.text).toMatch(/^sessions_send does not take `urgent`\. It takes: .*sessionId.*input/);
  expect(calls).toEqual([]);
});

test("an unknown key inside a batch item is refused with that item's accepted keys", async () => {
  const { caps, calls } = recordingCaps();
  const result = await socketCall(caps, "sessions_create", { projectId: "p", envMode: "worktree", tasks: [{ title: "a", task: "b", priority: 1 }] });
  expect(result.isError).toBe(true);
  expect(result.content[0]!.text).toBe("sessions_create `tasks.0` does not take `priority`. It takes: title, task, model, effort.");
  expect(calls).toEqual([]);
});

test("known arguments still reach the tool", async () => {
  const { caps, calls } = recordingCaps();
  await socketCall(caps, "notes_list", { projects: true });
  await sdkHandler(caps, "notes_list")({ projects: true });
  expect(calls).toEqual(["projects", "projects"]);
});

test("every agent tool advertises that it takes no undeclared argument, at any depth", () => {
  const { caps } = recordingCaps();
  const tools = [
    ...collectTelarWall(telarWall(() => caps)).map((tool) => ({ name: tool.name, schema: toolInputSchema(tool.shape) })),
    ...BROWSER_TOOLS.map((tool) => ({ name: tool.name, schema: toolInputSchema((tool.input as unknown as { shape: Record<string, unknown> }).shape) })),
  ];
  expect(tools.length).toBeGreaterThan(30);
  const open: string[] = [];
  const walk = (node: unknown, where: string): void => {
    if (Array.isArray(node)) return node.forEach((child, index) => walk(child, `${where}[${index}]`));
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (record.type === "object" && record.properties && record.additionalProperties !== false) open.push(where);
    for (const [key, value] of Object.entries(record)) walk(value, `${where}.${key}`);
  };
  for (const tool of tools) walk(tool.schema, tool.name);
  expect(open).toEqual([]);
});
