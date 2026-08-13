import { requestObject, requiredString, vnextEngine, vnextErrorResponse } from "@/lib/vnext/engine-server";

/**
 * ONE PROJECT'S MCP servers.
 *
 * SCOPE IS IN THE URL, not in a query parameter. `/api/mcp-servers` is the
 * machine's set and this is one repository's; making them the same route with a
 * filter is how a delete lands in the wrong scope.
 *
 * The GET also answers `effective` — the merge this project's sessions actually
 * run with, computed by the engine. The page that EXPLAINS which server wins
 * must not re-derive that rule, or the explanation and the behaviour become two
 * separate things to keep true.
 *
 * The SPEC IS FORWARDED UNVALIDATED, as with the global route: the engine parses
 * it against `McpServerSpec`, and a second copy of that check here could only
 * ever disagree with the first.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const { projectId } = await context.params;
    return Response.json(await (await vnextEngine()).listProjectMcpServers(projectId));
  } catch (error) {
    return vnextErrorResponse(error);
  }
}

export async function PUT(request: Request, context: Context) {
  try {
    const { projectId } = await context.params;
    const body = await requestObject(request);
    const result = await (await vnextEngine()).saveMcpServer({
      id: requiredString(body.id, "Server id"),
      projectId,
      ...(body.label === undefined ? {} : { label: requiredString(body.label, "Server label") }),
      ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
      spec: body.spec as never,
    });
    return Response.json(result);
  } catch (error) {
    return vnextErrorResponse(error);
  }
}
