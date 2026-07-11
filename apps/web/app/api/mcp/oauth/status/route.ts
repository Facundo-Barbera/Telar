import {
  checkMcpHealth,
  getMcpToken,
  getProject,
  getRecord,
  probeMcpAuth,
} from "@telar/core";

export const dynamic = "force-dynamic";

// Per-server connection/detection status for the settings UI. For EVERY http
// server we report { requiresOAuth, connected, expiresAt?, health }:
//   - requiresOAuth: probeMcpAuth(cfg.url) — OAuth is DETECTED, not declared
//     (docs/mcp-oauth-design.md §3). Probes run CONCURRENTLY; probeMcpAuth is
//     best-effort and already swallows network/parse errors (a down or non-OAuth
//     server ⇒ false), and we wrap it again so this route NEVER 500s.
//   - connected/expiresAt: from the stored OAuth record (a successful Connect),
//     never a `auth` block. WRITE-nothing, LEAK-nothing — only booleans + a
//     non-secret expiry, never the token.
//   - health: checkMcpHealth(cfg.url, { token }) — a live, AUTHENTICATED liveness
//     probe ("connected" | "needs-auth" | "error"). token is the mirrored OAuth
//     access token (getMcpToken keyed by the server name), only when a record
//     exists — otherwise we probe anonymously. Also best-effort: never 500s.
// stdio servers are omitted; the UI renders those as "Local" from the transport.
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

  const entries = await Promise.all(
    Object.entries(servers)
      .filter(([, cfg]) => cfg.transport === "http")
      .map(async ([name, cfg]) => {
        const url = cfg.transport === "http" ? cfg.url : "";
        const rec = getRecord(project, name);
        // Probe as us when we hold a mirrored OAuth token; anonymously otherwise.
        const token = rec ? getMcpToken(project, name) : undefined;
        // OAuth detection and the live health probe are independent — run them
        // concurrently. Both are wrapped so a single failure never bubbles into
        // a 500 (checkMcpHealth already returns "error" on any failure).
        const [requiresOAuth, health] = await Promise.all([
          probeMcpAuth(url)
            .then((r) => r.requiresOAuth)
            .catch(() => false),
          checkMcpHealth(url, { token }).catch(() => "error" as const),
        ]);
        return [
          name,
          {
            requiresOAuth,
            connected: Boolean(rec?.tokens.accessToken),
            expiresAt: rec?.tokens.expiresAt,
            health,
          },
        ] as const;
      }),
  );

  // Keyed by server name; the settings UI's normalizeStatus reads `servers` and
  // derives the pill (Connected / Requires sign-in / Ready) from these flags.
  return Response.json({ servers: Object.fromEntries(entries) });
}
