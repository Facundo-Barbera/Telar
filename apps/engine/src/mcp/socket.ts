/**
 * THE TRANSPORT CORE of Telar's hand-rolled streamable-HTTP MCP servers.
 *
 * Extracted from `spool/socket.ts` when the browser grew a socket of its own:
 * two sockets, one JSON-RPC dispatch. The engine's only other MCP machinery is
 * the Claude Agent SDK's IN-PROCESS `createSdkMcpServer` (see `driver.ts`),
 * which has no HTTP transport to mount, and the repo carries no
 * `@modelcontextprotocol/sdk`. Streamable HTTP for a stateless tools-only
 * server is small — JSON-RPC over POST: initialize, tools/list, tools/call,
 * ping — so this file implements exactly that and nothing speculative. No SSE
 * stream (a GET is answered 405, which the spec permits), no sessions, no
 * resources, no prompts.
 */
import { z } from "zod";

/** One tool, as the collecting factory sees it — name, prose, argument shape
 *  and the exact handler the SDK would run. */
export type SocketTool = {
  name: string;
  description: string;
  shape: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<{ content: unknown[]; isError?: boolean }>;
};

/** A tool's argument shape as JSON Schema, through zod's own converter — the
 *  descriptions a toolkit writes for a model ride along into `tools/list`. */
export function toolInputSchema(shape: Record<string, unknown>): Record<string, unknown> {
  return z.toJSONSchema(z.object(shape as Record<string, z.ZodType>), { io: "input" }) as Record<string, unknown>;
}

/** The newest protocol revision this file implements. A client asking for a
 *  plausible date-shaped version gets its own echoed back — this server's
 *  surface (tools only, stateless, no batch) is identical across them. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

type JsonRpcId = string | number | null;

const rpcResult = (id: JsonRpcId, result: unknown) => ({ jsonrpc: "2.0" as const, id, result });
const rpcError = (id: JsonRpcId, code: number, message: string) => ({ jsonrpc: "2.0" as const, id, error: { code, message } });

/**
 * ONE JSON-RPC MESSAGE IN, ONE ANSWER OUT — or `undefined` for a notification,
 * which the transport turns into 202 Accepted. Batches are not accepted; the
 * protocol revision this implements removed them.
 */
export async function handleSocketMessage(
  tools: readonly SocketTool[],
  message: unknown,
  options?: { serverInfo?: { name: string; version: string } },
): Promise<unknown | undefined> {
  const record = message as Record<string, unknown> | null;
  const id: JsonRpcId =
    record && (typeof record.id === "string" || typeof record.id === "number") ? (record.id as JsonRpcId) : null;
  if (!record || record.jsonrpc !== "2.0" || typeof record.method !== "string") {
    return rpcError(id, -32600, "expected a JSON-RPC 2.0 request object");
  }
  const method = record.method;
  // A notification expects no answer — acknowledging one with a response body
  // would be a protocol violation the strict clients actually check.
  if (record.id === undefined) return undefined;

  if (method === "initialize") {
    const params = record.params as Record<string, unknown> | undefined;
    const asked = typeof params?.protocolVersion === "string" ? params.protocolVersion : "";
    return rpcResult(id, {
      protocolVersion: /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: options?.serverInfo ?? { name: "telar-spool", version: "1.0.0" },
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
    // Validated against the toolkit's own shape, the check the SDK performs for
    // a session — a socket that skipped it would hand handlers arguments no
    // session could ever send.
    const parsed = z.object(tool.shape as Record<string, z.ZodType>).safeParse(args);
    if (!parsed.success) return rpcError(id, -32602, parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
    try {
      const result = await tool.run(parsed.data);
      return rpcResult(id, { content: result.content, ...(result.isError ? { isError: true } : {}) });
    } catch (error) {
      // The handlers answer errors as results; a throw is a bug or the store
      // refusing loudly, and either way the client gets the sentence.
      return rpcResult(id, {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      });
    }
  }
  return rpcError(id, -32601, `method "${method}" is not part of this server — it serves tools only`);
}
