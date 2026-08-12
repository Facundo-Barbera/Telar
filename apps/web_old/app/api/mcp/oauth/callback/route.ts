import { NextResponse } from "next/server";
import { completeConnect } from "@telar/core";
import { takePending } from "@/lib/mcp-oauth-pending";

export const dynamic = "force-dynamic";

// Redirect back to a project's MCP settings with a UI-readable flag. Values are
// deliberately short (server name + a reason) — the OAuth `code`/verifier are
// never echoed into the URL or logs (docs/mcp-oauth-design.md §6).
function settingsRedirect(req: Request, project: string, params: Record<string, string>) {
  const url = new URL(`/projects/${encodeURIComponent(project)}/settings`, req.url);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url);
}

// The authorization server redirects the browser back here with ?code&state
// (or ?error on denial). We take() the pending flow by state — single-use, so a
// replayed callback finds nothing — then completeConnect validates state,
// exchanges the code, writes the record + mirrors the access token. Success and
// failure both bounce to the settings page with a flag rather than rendering.
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const state = q.get("state") ?? "";
  const code = q.get("code") ?? "";
  const providerError = q.get("error"); // AS-reported, e.g. access_denied

  const pending = takePending(state);
  if (!pending) {
    // Unknown/expired state → we can't trust the project either. Bounce to the
    // project list with a generic message; leak nothing about the attempt.
    const back = new URL("/projects", req.url);
    back.searchParams.set("mcpOAuthError", "This MCP connection link expired or is invalid — please try again.");
    return NextResponse.redirect(back);
  }

  const { project, server, ctx } = pending;

  if (providerError) {
    const desc = q.get("error_description");
    return settingsRedirect(req, project, { mcpOAuthError: `${server}: ${desc || providerError}` });
  }
  if (!code) {
    return settingsRedirect(req, project, { mcpOAuthError: `${server}: authorization server returned no code.` });
  }

  try {
    await completeConnect({ project, server, ctx, code, returnedState: state });
    return settingsRedirect(req, project, { mcpConnected: server });
  } catch (e) {
    const reason = e instanceof Error ? e.message : "OAuth token exchange failed.";
    return settingsRedirect(req, project, { mcpOAuthError: `${server}: ${reason}` });
  }
}
