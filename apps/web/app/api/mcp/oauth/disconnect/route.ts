import { clearMcpToken, deleteRecord } from "@telar/core";

export const dynamic = "force-dynamic";

// Forget a stored MCP OAuth session: drop the McpOAuthRecord and clear the
// mirrored `mcp:<project>:<server>` access token the resolver reads. Idempotent;
// `ok` reports whether a record actually existed. Server-derived body only.
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const project = typeof body?.project === "string" ? body.project.trim() : "";
  const server = typeof body?.server === "string" ? body.server.trim() : "";
  if (!project || !server) {
    return Response.json({ error: "project and server (strings) are required." }, { status: 400 });
  }
  const removed = deleteRecord(project, server);
  clearMcpToken(project, server);
  return Response.json({ ok: removed });
}
