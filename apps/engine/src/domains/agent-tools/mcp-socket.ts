import crypto from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import { z } from "zod";
import { atomicWrite } from "../../platform/fs/atomic";
import type { ToolCallContext } from "./tool-kit";

export type SocketTool = {
  name: string;
  description: string;
  shape: Record<string, unknown>;
  run: (args: Record<string, unknown>, context?: ToolCallContext) => Promise<{ content: unknown[]; isError?: boolean }>;
};

export function collectTools<Capability>(
  build: (
    tool: (
      name: string,
      description: string,
      shape: Record<string, unknown>,
      handler: (args: Record<string, unknown>, context?: ToolCallContext) => Promise<{ content: unknown[]; isError?: boolean }>,
    ) => unknown,
    capability: Capability,
  ) => unknown[],
  capability: Capability,
): SocketTool[] {
  const collected: SocketTool[] = [];
  build((name, description, shape, handler) => {
    const tool: SocketTool = { name, description, shape, run: handler };
    collected.push(tool);
    return tool;
  }, capability);
  return collected;
}

export function toolInputSchema(shape: Record<string, unknown>): Record<string, unknown> {
  return leanSchema(z.toJSONSchema(z.object(shape as Record<string, z.ZodType>), { io: "input" })) as Record<string, unknown>;
}

const UNADVERTISED = new Set(["$schema", "minLength", "maxLength", "maxItems"]);

/** The advertised schema only; calls are still validated against the full zod shape. */
function leanSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(leanSchema);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (UNADVERTISED.has(key)) continue;
    if ((key === "maximum" || key === "minimum") && Math.abs(Number(value)) === Number.MAX_SAFE_INTEGER) continue;
    out[key] = leanSchema(value);
  }
  return out;
}

type ListHandler = (request: unknown, extra: unknown) => Promise<{ tools?: { inputSchema?: unknown }[] }>;

export function advertiseLeanSchemas<Server>(server: Server): Server {
  const handlers = (server as { instance?: { server?: { _requestHandlers?: Map<string, ListHandler> } } }).instance?.server?._requestHandlers;
  const list = handlers?.get("tools/list");
  if (!handlers || !list) return server;
  handlers.set("tools/list", async (request, extra) => {
    const answer = await list(request, extra);
    return { ...answer, tools: answer.tools?.map((tool) => ({ ...tool, inputSchema: leanSchema(tool.inputSchema) })) };
  });
  return server;
}

export function ensureSecretFile(file: string): string {
  try {
    const stored = JSON.parse(fs.readFileSync(file, "utf8")) as { secret?: unknown };
    if (typeof stored.secret === "string" && stored.secret.length >= 32) return stored.secret;
  } catch {
  }
  const secret = crypto.randomBytes(32).toString("base64url");
  atomicWrite(file, { secret, schemaVersion: 1 });
  return secret;
}

export function connectCard(name: string, url: string, secret: string): { url: string; secret: string; addCommand: string } {
  return {
    url,
    secret,
    addCommand: `claude mcp add --transport http ${name} ${url} --header "Authorization: Bearer ${secret}"`,
  };
}

export async function readSocketBody(request: http.IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > 1_000_000) return undefined;
    chunks.push(buffer);
  }
  if (total === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

const MCP_PROTOCOL_VERSION = "2025-06-18";

type JsonRpcId = string | number | null;

const rpcResult = (id: JsonRpcId, result: unknown) => ({ jsonrpc: "2.0" as const, id, result });
const rpcError = (id: JsonRpcId, code: number, message: string) => ({ jsonrpc: "2.0" as const, id, error: { code, message } });

export async function handleSocketMessage(
  tools: readonly SocketTool[],
  message: unknown,
  server: { name: string; version: string },
): Promise<unknown | undefined> {
  const record = message as Record<string, unknown> | null;
  const id: JsonRpcId =
    record && (typeof record.id === "string" || typeof record.id === "number") ? (record.id as JsonRpcId) : null;
  if (!record || record.jsonrpc !== "2.0" || typeof record.method !== "string") {
    return rpcError(id, -32600, "expected a JSON-RPC 2.0 request object");
  }
  const method = record.method;
  if (record.id === undefined) return undefined;

  if (method === "initialize") {
    const params = record.params as Record<string, unknown> | undefined;
    const asked = typeof params?.protocolVersion === "string" ? params.protocolVersion : "";
    return rpcResult(id, {
      protocolVersion: /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: server.name, version: server.version },
    });
  }
  if (method === "ping") return rpcResult(id, {});
  if (method === "tools/list") {
    return rpcResult(id, {
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: toolInputSchema(tool.shape),
      })),
    });
  }
  if (method === "tools/call") {
    const params = record.params as Record<string, unknown> | undefined;
    const name = typeof params?.name === "string" ? params.name : "";
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) return rpcError(id, -32602, `no tool named "${name}" — tools/list names what this socket serves`);
    const args = params?.arguments && typeof params.arguments === "object" ? (params.arguments as Record<string, unknown>) : {};
    const parsed = z.object(tool.shape as Record<string, z.ZodType>).safeParse(args);
    if (!parsed.success) return rpcError(id, -32602, parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
    try {
      const result = await tool.run(parsed.data);
      return rpcResult(id, { content: result.content, ...(result.isError ? { isError: true } : {}) });
    } catch (error) {
      return rpcResult(id, {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      });
    }
  }
  return rpcError(id, -32601, `method "${method}" is not part of this server — it serves tools only`);
}
