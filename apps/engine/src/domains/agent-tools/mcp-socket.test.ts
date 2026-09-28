import { expect, test } from "bun:test";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { advertiseLeanSchemas, handleSocketMessage, toolInputSchema } from "./mcp-socket";

const shape = {
  sessionId: z.string().min(1).max(200).describe("Which session."),
  tabId: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  timeoutMs: z.number().int().min(0).max(60_000),
  kind: z.enum(["a", "b"]).optional(),
  tags: z.array(z.string()).max(8).optional(),
};

const noise = (schema: unknown) => JSON.stringify(schema).match(/"\$schema"|"minLength"|"maxLength"|"maxItems"|9007199254740991/g) ?? [];

test("the socket advertises a lean schema that still says what a model needs", () => {
  const schema = toolInputSchema(shape) as { properties: Record<string, Record<string, unknown>>; required: string[] };
  expect(noise(schema)).toEqual([]);
  expect(schema.required).toEqual(["sessionId", "timeoutMs"]);
  expect(schema.properties.sessionId!.description).toBe("Which session.");
  expect(schema.properties.timeoutMs).toMatchObject({ minimum: 0, maximum: 60_000 });
  expect(schema.properties.kind!.enum).toEqual(["a", "b"]);
});

test("the socket still refuses a call the full shape refuses", async () => {
  const tools = [{ name: "t", description: "d", shape, run: async () => ({ content: [{ type: "text", text: "ran" }] }) }];
  const answer = (await handleSocketMessage(tools, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "t", arguments: { sessionId: "", timeoutMs: 1 } } }, {
    name: "s",
    version: "1",
  })) as { error?: { message: string } };
  expect(answer.error?.message).toContain("sessionId");
});

test("Claude's in-process server advertises lean schemas and validates calls against the full shape", async () => {
  let ran = 0;
  const server = advertiseLeanSchemas(
    createSdkMcpServer({
      name: "telar",
      version: "1",
      tools: [tool("t", "d", shape, async () => ((ran += 1), { content: [{ type: "text", text: "ran" }] }))],
    }),
  );
  const handlers = (server as unknown as { instance: { server: { _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<unknown>> } } })
    .instance.server._requestHandlers;
  const listed = (await handlers.get("tools/list")!({ method: "tools/list", params: {} }, {})) as { tools: { inputSchema: unknown }[] };
  expect(listed.tools).toHaveLength(1);
  expect(noise(listed.tools[0]!.inputSchema)).toEqual([]);
  expect(JSON.stringify(listed.tools[0]!.inputSchema)).toContain("Which session.");

  const refused = (await handlers.get("tools/call")!(
    { method: "tools/call", params: { name: "t", arguments: { sessionId: "", timeoutMs: 1 } } },
    { signal: new AbortController().signal, requestId: 1, sendNotification: async () => {}, sendRequest: async () => ({}) },
  )) as { isError?: boolean };
  expect(refused.isError).toBe(true);
  expect(ran).toBe(0);
});
