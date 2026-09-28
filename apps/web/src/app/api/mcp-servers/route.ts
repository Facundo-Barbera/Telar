import { requestObject, requiredString, engineClient, engineRoute } from "@/platform/engine/server";

/**
 * The user's own MCP servers.
 *
 * NOT UNDER A PROJECT OR A SESSION. They are environment-scoped in the engine
 * for a reason a route should not quietly contradict: a tool server is
 * configured once, and per-session copies would mean re-entering credentials
 * per conversation with no answer to which copy is authoritative.
 *
 * The SPEC IS FORWARDED UNVALIDATED and that is deliberate — the engine parses
 * it against `McpServerSpec`, so re-checking the transport arms here would be a
 * second copy of the same rule that could disagree with the first.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = engineRoute(async () => {
  return Response.json(await (await engineClient()).listMcpServers());
});

export const PUT = engineRoute(async (request: Request) => {
  const body = await requestObject(request);
  const result = await (await engineClient()).saveMcpServer({
    id: requiredString(body.id, "Server id"),
    ...(body.label === undefined ? {} : { label: requiredString(body.label, "Server label") }),
    ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
    spec: body.spec as never,
  });
  return Response.json(result);
});
