import { requestObject, requiredString, engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

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

export async function GET() {
  try {
    return Response.json(await (await engineClient()).listMcpServers());
  } catch (error) {
    return engineErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const body = await requestObject(request);
    const result = await (await engineClient()).saveMcpServer({
      id: requiredString(body.id, "Server id"),
      ...(body.label === undefined ? {} : { label: requiredString(body.label, "Server label") }),
      ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
      spec: body.spec as never,
    });
    return Response.json(result);
  } catch (error) {
    return engineErrorResponse(error);
  }
}
