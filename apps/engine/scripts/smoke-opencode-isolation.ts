/** Two real servers in the same checkout must not share runtime MCP registrations. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { startOpenCodeRuntime, type OpenCodeRuntime } from "../src/opencode/runtime";
const binaryPath = process.argv[2];
if (!binaryPath) throw new Error("Pass the absolute path of the supported OpenCode binary");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-opencode-isolation-"));
const runtimes: OpenCodeRuntime[] = [];
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const body = await request.json() as { id?: number; method: string };
  if (body.id === undefined) return new Response(null, { status: 204 });
  const result = body.method === "initialize" ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
    : body.method === "tools/list" ? { tools: [{ name: "fixture", description: "Isolation fixture", inputSchema: { type: "object", properties: {} } }] } : {};
  return Response.json({ jsonrpc: "2.0", id: body.id, result });
} });
try {
  const input = { sessionId: "session_a", binaryPath: path.resolve(binaryPath), cwd: root, prompt: "", signal: AbortSignal.timeout(30_000), onObservations: async () => {},
    env: { XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"), OPENCODE_DISABLE_MODELS_FETCH: "1" } };
  const a = await startOpenCodeRuntime(input); runtimes.push(a);
  const b = await startOpenCodeRuntime({ ...input, sessionId: "session_b" }); runtimes.push(b);
  const options = { throwOnError: true as const, signal: AbortSignal.timeout(10_000) };
  await a.client.mcp.add({ name: "only_a", config: { type: "remote", url: `http://127.0.0.1:${server.port}/mcp`, oauth: false } }, options);
  const [first, second] = await Promise.all([a.client.mcp.status({}, options), b.client.mcp.status({}, options)]);
  assert.equal(first.data?.only_a?.status, "connected");
  assert.equal(second.data?.only_a, undefined);
  assert.equal(fs.existsSync(path.join(root, "opencode.json")), false);
  a.close();
  assert.ok((await b.client.global.health(options)).data?.healthy);
  console.log("OPENCODE_SAME_DIRECTORY_ISOLATION_OK");
} finally {
  for (const runtime of runtimes) runtime.close();
  server.stop(true); await Bun.sleep(1_500);
  fs.rmSync(root, { recursive: true, force: true });
}
