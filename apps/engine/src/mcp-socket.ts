/**
 * AN OUTWARD MCP SOCKET, WITHOUT THE WALL IT SERVES.
 *
 * The Spool built this shape first (`spool/socket.ts`, `docs/spool-loops.md`
 * §10.3): any LLM client the user owns reaches the SAME tool wall a Telar
 * session gets, over Streamable HTTP, behind a dedicated secret that is not the
 * engine's management token. The `sessions` toolkit wants exactly the same
 * thing, so the transport, the secret and the connect card live here and the
 * two sockets differ only in which wall they collect and what they call
 * themselves.
 *
 * EXTRACTED RATHER THAN COPIED, and the distinction is the point: a second
 * hand-written JSON-RPC loop would drift from the first the moment either was
 * fixed, and the protocol details below (a notification is answered with
 * nothing; a batch is not accepted; a client's own date-shaped version is
 * echoed) are precisely the kind that get fixed once and forgotten.
 *
 * ── THE TRANSPORT IS STREAMABLE HTTP, IMPLEMENTED BY HAND ───────────────────
 * The engine's only MCP machinery is the Claude Agent SDK's IN-PROCESS
 * `createSdkMcpServer` (see `driver.ts`), which has no HTTP transport to mount,
 * and the repo carries no `@modelcontextprotocol/sdk`. Streamable HTTP for a
 * stateless tools-only server is small — JSON-RPC over POST: initialize,
 * tools/list, tools/call, ping — so this file implements exactly that and
 * nothing speculative. No SSE stream (a GET is answered 405, which the spec
 * permits), no sessions, no resources, no prompts.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { z } from "zod";
import { atomicWrite } from "./atomic";

/** One wall tool, as the collecting factory sees it — name, prose, argument
 *  shape and the exact handler the SDK would run. */
export type SocketTool = {
  name: string;
  description: string;
  shape: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<{ content: unknown[]; isError?: boolean }>;
};

/**
 * The seam every Telar toolkit already has: `spoolTools`/`sessionsTools` take
 * their `tool` factory as an argument precisely so a caller can decide what
 * "register" means. Here it means "remember", and the result is the wall's own
 * list with the wall's own handlers — the same seam the bare-harness tests use,
 * so parity between a socket and a session's toolkit is STRUCTURAL rather than
 * maintained by hand.
 */
export function collectTools<Capability>(
  build: (
    tool: (
      name: string,
      description: string,
      shape: Record<string, unknown>,
      handler: (args: Record<string, unknown>) => Promise<{ content: unknown[]; isError?: boolean }>,
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

/** A tool's argument shape as JSON Schema, through zod's own converter — the
 *  descriptions the wall writes for a model ride along into `tools/list`. */
export function toolInputSchema(shape: Record<string, unknown>): Record<string, unknown> {
  return z.toJSONSchema(z.object(shape as Record<string, z.ZodType>), { io: "input" }) as Record<string, unknown>;
}

/**
 * A socket's secret: read it, or mint it exactly once. 32 random bytes,
 * base64url — the same strength as the engine token it deliberately is not.
 *
 * ── A DEDICATED SECRET, NOT THE MANAGEMENT TOKEN ────────────────────────────
 * The bearer token in `engine.json` is engine ADMIN: sessions, files, turns. A
 * chat client configured with a socket's secret holds THAT WALL and nothing
 * else, so a leaked chat config cannot cost more than the wall could ever do.
 *
 * An unreadable file is re-minted rather than thrown on: the secret grants
 * nothing but the wall, and every connect card reads the current one.
 */
export function ensureSecretFile(file: string): string {
  try {
    const stored = JSON.parse(fs.readFileSync(file, "utf8")) as { secret?: unknown };
    if (typeof stored.secret === "string" && stored.secret.length >= 32) return stored.secret;
  } catch {
    // absent or unreadable — mint below
  }
  const secret = crypto.randomBytes(32).toString("base64url");
  atomicWrite(file, { secret, schemaVersion: 1 });
  return secret;
}

/** The connect card, composed in one place so the card and the socket cannot
 *  disagree about the header shape. `name` is what the user's client will call
 *  this server locally. */
export function connectCard(name: string, url: string, secret: string): { url: string; secret: string; addCommand: string } {
  return {
    url,
    secret,
    addCommand: `claude mcp add --transport http ${name} ${url} --header "Authorization: Bearer ${secret}"`,
  };
}

/** The newest protocol revision this file implements. A client asking for a
 *  plausible date-shaped version gets its own echoed back — a socket's surface
 *  (tools only, stateless, no batch) is identical across them. */
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
  server: { name: string; version: string },
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
    // Validated against the wall's own shape, the check the SDK performs for a
    // session — a socket that skipped it would hand handlers arguments no
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
