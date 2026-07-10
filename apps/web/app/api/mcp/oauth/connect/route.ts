import { beginConnect, getProject } from "@telar/core";
import { putPending } from "@/lib/mcp-oauth-pending";

export const dynamic = "force-dynamic";

// The client-identity ladder throws this when it can resolve no client: the AS
// does neither CIMD nor DCR and no manual clientId is configured. We surface it
// as an actionable 422 (+ needsClientId) so the UI can prompt for a manual
// clientId in Configure → Advanced instead of showing a blank 5xx.
const NO_CLIENT_STRATEGY = "no usable client-identity strategy";

// Start a browser OAuth connect for an http MCP server. OAuth is DETECTED, not
// declared (docs/mcp-oauth-design.md §3): we allow Connect for ANY http server
// and never gate on an `auth.type === "oauth"` block. The manifest `auth`, when
// present, is passed to beginConnect only as OPTIONAL overrides (manual clientId
// / scopes / AS pin); its absence does NOT disable OAuth. EVERYTHING is derived
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
  if (cfg.transport !== "http") {
    return Response.json({ error: `MCP server "${server}" is not an http server.` }, { status: 400 });
  }

  // Optional overrides only — an absent block means pure autodetect.
  const auth = cfg.auth ?? { type: "oauth" as const };

  try {
    const ctx = await beginConnect({ project, server, serverUrl: cfg.url, auth });
    putPending({ project, server, ctx, createdAt: Date.now() });
    return Response.json({ url: ctx.authorizationUrl });
  } catch (e) {
    const message = e instanceof Error ? e.message : "failed to begin OAuth connect";
    if (message.includes(NO_CLIENT_STRATEGY)) {
      return Response.json(
        {
          error: `"${server}" can't self-register — add a client ID under Configure → Advanced (from the server's dashboard), Save, then Connect again.`,
          needsClientId: true,
        },
        { status: 422 },
      );
    }
    return Response.json({ error: message }, { status: 502 });
  }
}
