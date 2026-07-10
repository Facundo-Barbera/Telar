import { getProject, getRecord } from "@telar/core";

export const dynamic = "force-dynamic";

// Connection status for a project's OAuth MCP servers — for the settings UI to
// render connected / expired / not-connected per server. WRITE-nothing and
// LEAK-nothing: only booleans + a non-secret expiry/scope, never the token.
export async function GET(req: Request) {
  const project = new URL(req.url).searchParams.get("project")?.trim() ?? "";
  if (!project) {
    return Response.json({ error: "project (query) is required." }, { status: 400 });
  }

  let servers;
  try {
    servers = getProject(project).manifest.mcpServers;
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "unknown project" }, { status: 404 });
  }

  const now = Date.now();
  const status: Record<string, { connected: boolean; expired?: boolean; expiresAt?: number; scope?: string }> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    if (cfg.transport !== "http" || cfg.auth?.type !== "oauth") continue;
    const rec = getRecord(project, name);
    status[name] = rec
      ? {
          connected: Boolean(rec.tokens.accessToken),
          expired: rec.tokens.expiresAt !== undefined && now >= rec.tokens.expiresAt,
          expiresAt: rec.tokens.expiresAt,
          scope: rec.tokens.scope,
        }
      : { connected: false };
  }
  // The settings UI's normalizeOAuthStatus reads `servers`, keyed by server name,
  // and derives the pill from the connected/expired booleans (never the token).
  return Response.json({ servers: status });
}
