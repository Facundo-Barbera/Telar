import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The socket's connect card (loops §10.3): where the outward MCP server
 * listens, its DEDICATED secret — not the engine's management token, so a
 * chat client that leaks it has not leaked engine admin — and the composed
 * `claude mcp add` line. Served behind the cockpit like every route here.
 */
export async function GET() {
  try {
    return Response.json(await (await engineClient()).spoolMcpInfo());
  } catch (error) {
    return engineErrorResponse(error);
  }
}
