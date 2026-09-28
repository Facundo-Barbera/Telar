import { optionalString, requestObject, requiredString, engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * Sign-in state for the MCP servers in one scope, and the two writes that
 * change it.
 *
 * THE REDIRECT ORIGIN IS TAKEN FROM THIS REQUEST, not from the client's body
 * and not from a constant. The authorization server will send the browser back
 * to whatever we register, so it has to be the origin the person is actually
 * looking at — this cockpit answers on localhost, on a LAN address and on a
 * tailnet name, and a hardcoded one would work on exactly one of them. A
 * client-supplied origin would be worse still: it is the one field in an OAuth
 * flow that must not be attacker-chosen.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const projectId = new URL(request.url).searchParams.get("projectId")?.trim();
    return Response.json(await (await engineClient()).mcpOAuthStatus(projectId || undefined));
  } catch (error) {
    return engineErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await requestObject(request);
    const serverId = requiredString(body.serverId, "Server id");
    const projectId = optionalString(body.projectId, "Project id");
    if (body.action === "disconnect") {
      return Response.json(
        await (await engineClient()).disconnectMcpOAuth({ serverId, ...(projectId ? { projectId } : {}) }),
      );
    }
    return Response.json(
      await (await engineClient()).connectMcpOAuth({
        serverId,
        ...(projectId ? { projectId } : {}),
        redirectOrigin: new URL(request.url).origin,
      }),
    );
  } catch (error) {
    return engineErrorResponse(error);
  }
}
