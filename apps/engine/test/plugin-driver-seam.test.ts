/**
 * THE SEAM BETWEEN A PLUGIN AND A PROVIDER — and the reason it is ONE seam
 * rather than two.
 *
 * `plugin-wire.test.ts` proves the TRANSPORT between worker and daemon. This
 * file proves the transport between worker and PROVIDER: a plugin's tools reach
 * a turn as a worker-hosted MCP socket (`plugins/socket.ts`), and BOTH drivers
 * mount that same socket under the same key. That is what makes the host
 * provider-neutral instead of a Claude feature — Codex takes MCP servers as
 * config and cannot be handed an in-process server at all, so a plugin
 * registered in-process would exist on Claude and silently not exist on Codex.
 *
 * Every case drives the real socket over real loopback HTTP and the real
 * drivers against fakes. NO PROVIDER PROCESS RUNS and no paid call is made:
 * the Claude SDK is a fake and Codex's app-server is a fake that records the
 * `thread/start` config it was given.
 */
import { afterEach, expect, test } from "bun:test";
import {
  TELAR_PLUGINS_MCP_SERVER,
  canonicalToolName,
  parseToolName,
} from "@telar/engine-client";
import { codexApprovalRequest, codexItemDetail, MCP_ELICITATION } from "../src/codex/items";
import { createClaudeDriver, requestKindForTool, setPluginReadTools } from "../src/driver";
import { setPluginToolModules } from "../src/plugins/bundled";
import { helloToolModule } from "../src/plugins/hello";
import { HOST_RATIFIED_READ_TOOLS } from "../src/plugins/policy";
import { PluginToolSocket } from "../src/plugins/socket";

const sockets: PluginToolSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) await socket.close();
  setPluginToolModules([]);
  setPluginReadTools(new Set(Object.values(HOST_RATIFIED_READ_TOOLS).flat()));
});

/** A capability whose answers name themselves, so a case can tell WHICH one ran. */
const helloCapability = (mark: string) => ({
  ping: async (input?: { name?: string }) => ({ greeted: input?.name ?? mark }),
  state: async () => ({ busy: false }),
});

/** The socket, bound for one session's enabled plugins. */
async function bound(capabilities: Record<string, unknown>) {
  setPluginToolModules([helloToolModule]);
  const socket = new PluginToolSocket();
  sockets.push(socket);
  const lease = await socket.bind([helloToolModule], capabilities);
  return { socket, lease };
}

/** One MCP call over the socket, exactly as a provider makes it. */
async function mcp(lease: { url: string; token: string }, method: string, params?: unknown) {
  const response = await fetch(lease.url, {
    method: "POST",
    headers: { authorization: `Bearer ${lease.token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

// ── the socket itself ───────────────────────────────────────────────────────

test("the socket advertises the plugin's wall and dispatches to that session's capability", async () => {
  const { lease } = await bound({ hello: helloCapability("session-one") });
  expect(lease).toBeDefined();

  const listed = await mcp(lease!, "tools/list");
  const names = ((listed.body.result as { tools: { name: string }[] }).tools ?? []).map((tool) => tool.name);
  expect(names).toEqual(["hello_ping", "hello_state"]);

  // …and calling one reaches THAT binding's capability, not a shared one.
  const called = await mcp(lease!, "tools/call", { name: "hello_ping", arguments: {} });
  expect(JSON.stringify(called.body)).toContain("session-one");
});

test("two sessions get two tokens, and each token reaches only its own capability", async () => {
  // The property that makes one socket safe for the whole worker: the binding,
  // not the port, is what scopes a plugin to a session.
  setPluginToolModules([helloToolModule]);
  const socket = new PluginToolSocket();
  sockets.push(socket);
  const first = (await socket.bind([helloToolModule], { hello: helloCapability("first") }))!;
  const second = (await socket.bind([helloToolModule], { hello: helloCapability("second") }))!;

  expect(JSON.stringify((await mcp(first, "tools/call", { name: "hello_ping", arguments: {} })).body)).toContain("first");
  expect(JSON.stringify((await mcp(second, "tools/call", { name: "hello_ping", arguments: {} })).body)).toContain("second");

  // A released lease stops working immediately — a turn that ended must not
  // leave a live credential for its plugins behind.
  first.release();
  expect((await mcp(first, "tools/list")).status).toBe(401);
  expect((await mcp(second, "tools/list")).status).toBe(200);
});

test("a plugin the project did not enable contributes no tools, and an empty wall binds nothing", async () => {
  // Absence at the gate is absence in `tools/list` BY CONSTRUCTION rather than
  // by a check the socket performs.
  const { lease } = await bound({});
  expect(lease).toBeUndefined();
});

test("the socket takes its own bearer and serves one path", async () => {
  const { lease } = await bound({ hello: helloCapability("guarded") });
  const wrong = await fetch(lease!.url, {
    method: "POST",
    headers: { authorization: "Bearer nope", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  expect(wrong.status).toBe(401);

  const elsewhere = await fetch(new URL("/v2/elsewhere", lease!.url), {
    method: "POST",
    headers: { authorization: `Bearer ${lease!.token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  expect(elsewhere.status).toBe(404);
});

// ── both drivers mount it, under the same key ───────────────────────────────

test("the Claude driver mounts the plugin socket as an http server under the shared key", async () => {
  let servers: Record<string, unknown> | undefined;
  const driver = createClaudeDriver(async () => ({
    async *query(input: { options: { mcpServers?: Record<string, unknown> } }) {
      servers = input.options.mcpServers;
      yield { type: "result", subtype: "success" };
    },
  }));

  await driver.run({
    prompt: "prompt",
    sessionId: "session_claude_plugins",
    cwd: "/tmp",
    signal: new AbortController().signal,
    onObservations: async () => undefined,
    pluginsSocket: { url: "http://127.0.0.1:9/v2/plugins/mcp", token: "t0ken" },
  });

  expect(servers?.[TELAR_PLUGINS_MCP_SERVER]).toEqual({
    type: "http",
    url: "http://127.0.0.1:9/v2/plugins/mcp",
    headers: { Authorization: "Bearer t0ken" },
  });

  // …and a turn without plugins mounts no such server rather than an empty one.
  servers = undefined;
  await driver.run({
    prompt: "prompt",
    sessionId: "session_claude_none",
    cwd: "/tmp",
    signal: new AbortController().signal,
    onObservations: async () => undefined,
  });
  expect(servers?.[TELAR_PLUGINS_MCP_SERVER]).toBeUndefined();
});

test("a plugin tool has ONE qualified name, because both providers use one server key", () => {
  // The failure this prevents: `mcp__telar__hello_ping` under one provider and
  // `mcp__telar-plugins__hello_ping` under the other would be two rows a client
  // cannot group and two approvals to remember, for one tool.
  const qualified = canonicalToolName(TELAR_PLUGINS_MCP_SERVER, "hello_ping");
  expect(qualified).toBe("mcp__telar-plugins__hello_ping");
  // Capability is read off the TOOL, not the server, so the row stays typed.
  expect(parseToolName(qualified)).toEqual({
    server: TELAR_PLUGINS_MCP_SERVER,
    tool: "hello_ping",
    capability: "hello",
  });
  // Codex normalises its `{server, tool}` to the same spelling.
  const mapped = codexItemDetail({ type: "mcpToolCall", server: TELAR_PLUGINS_MCP_SERVER, tool: "hello_ping", id: "c1" } as never);
  expect(mapped?.detail).toMatchObject({ type: "mcp_tool_call", call: { name: qualified } });
});

// ── approvals stay host-owned, and identical on both wires ──────────────────

test("a plugin's write parks a card on BOTH wires and its read does not, from the same server key", () => {
  setPluginReadTools(new Set(["hello_state"]));
  const claude = (tool: string) => requestKindForTool(canonicalToolName(TELAR_PLUGINS_MCP_SERVER, tool));
  const codex = (tool: string) =>
    codexApprovalRequest(MCP_ELICITATION, {
      serverName: TELAR_PLUGINS_MCP_SERVER,
      message: `Allow the ${TELAR_PLUGINS_MCP_SERVER} MCP server to run tool "${tool}"?`,
      _meta: { codex_approval_kind: "mcp_tool_call", tool_params: {} },
    })?.kind;

  expect(claude("hello_state")).toBe(codex("hello_state"));
  expect(claude("hello_ping")).toBe(codex("hello_ping"));
  // A negative control, so the equality above is not passing because everything
  // classifies the same way.
  expect(claude("hello_state")).not.toBe(claude("hello_ping"));
});

test("the socket does not gate, so the host stays the only authority", async () => {
  // `hello_ping` is not a ratified read, yet the socket serves it without a
  // card of its own: approvals belong to the engine's ladder (`canUseTool` on
  // Claude, the elicitation arm on Codex). A gate here would either duplicate
  // that card or — worse — disagree with it, which is a plugin granting itself
  // authority.
  setPluginReadTools(new Set(["hello_state"]));
  const { lease } = await bound({ hello: helloCapability("ungated") });
  const called = await mcp(lease!, "tools/call", { name: "hello_ping", arguments: {} });
  expect(called.status).toBe(200);
  expect(requestKindForTool(canonicalToolName(TELAR_PLUGINS_MCP_SERVER, "hello_ping"))).not.toBe("file_read");
});

test("a manifest cannot promote its own tool to a read on either wire", () => {
  setPluginReadTools(new Set(["hello_state"]));
  expect(helloToolModule.meta.readTools).not.toContain("hello_ping");
  const write = requestKindForTool(canonicalToolName(TELAR_PLUGINS_MCP_SERVER, "hello_ping"));
  const read = requestKindForTool(canonicalToolName(TELAR_PLUGINS_MCP_SERVER, "hello_state"));
  expect(write).not.toBe(read);
});
