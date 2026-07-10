import { beginConnect, getProject } from "@telar/core";
import { putPending } from "@/lib/mcp-oauth-pending";

export const dynamic = "force-dynamic";

// Start a browser OAuth connect for an http MCP server whose manifest declares
// `auth.type === "oauth"` (docs/mcp-oauth-design.md §5). EVERYTHING is derived
// server-side from the manifest — the client only names { project, server }; we
// never trust a client-supplied verifier/state. beginConnect runs discovery →
// the client-identity ladder → PKCE → the authorization URL; we stash the
// resulting ConnectContext (keyed by state) for the /callback and return just
// the authorization URL for the client to navigate the browser to.
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const project = typeof body?.project === "string" ? body.project.trim() : "";
  const server = typeof body?.server === "string" ? body.server.trim() : "";
  if (!project || !server) {
    return Response.json({ error: "project and server (strings) are required." }, { status: 400 });
  }

  let cfg;
  try {
    cfg = getProject(project).manifest.mcpServers[server];
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "unknown project" }, { status: 404 });
  }
  if (!cfg) {
    return Response.json({ error: `Unknown MCP server "${server}" in project "${project}".` }, { status: 404 });
  }
  if (cfg.transport !== "http" || cfg.auth?.type !== "oauth") {
    return Response.json({ error: `MCP server "${server}" is not an OAuth server.` }, { status: 400 });
  }

  try {
    const ctx = await beginConnect({ project, server, serverUrl: cfg.url, auth: cfg.auth });
    putPending({ project, server, ctx, createdAt: Date.now() });
    return Response.json({ url: ctx.authorizationUrl });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "failed to begin OAuth connect" },
      { status: 502 },
    );
  }
}
