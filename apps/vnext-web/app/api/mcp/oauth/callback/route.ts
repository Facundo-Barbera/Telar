import { redirect } from "next/navigation";
import { vnextEngine } from "@/lib/vnext/engine-server";

/**
 * WHERE THE AUTHORIZATION SERVER SENDS THE BROWSER BACK.
 *
 * IT LANDS HERE AND NOT ON THE ENGINE, and that split is the design rather than
 * an accident of which process owns a port. The engine listens on loopback
 * behind a bearer token no browser has; the cockpit is the thing a person
 * actually has open. So the registered redirect URI is the cockpit's, and this
 * route hands the `code` back to the engine over the authenticated channel it
 * already holds.
 *
 * THE HALF THAT MATTERS NEVER COMES HERE. The PKCE verifier and the flow's own
 * `state` stayed in the engine, keyed by the state the authorization server
 * echoes. A `code` observed in this process — in a log, in the address bar, in
 * a referrer header — cannot be exchanged without the verifier it never saw.
 *
 * BOTH OUTCOMES REDIRECT AND NEITHER RENDERS. Someone arriving from a consent
 * screen is mid-task, and the place to finish is the settings page they left.
 * The reason travels as a short query parameter; the `code` is never echoed
 * into a URL, a log or a redirect.
 *
 * `redirect()` WORKS BY THROWING, so every call to it is outside the try — a
 * redirect inside one would be caught by the handler meant for the engine's
 * failures and turned into the opposite outcome.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * `section=mcp` IS LOAD-BEARING, not decoration.
 *
 * Settings renders one pane at a time, and the machine-wide page opens on
 * Appearance. Without this the browser comes back from the consent screen to a
 * colour-scheme picker: the grant is stored, the flow worked, and the person is
 * told nothing — while the announcement sits unread in a pane that never
 * mounted, ready to fire the next time it does. Found by pressing the button.
 */
function settingsUrl(projectId: string | undefined, params: Record<string, string>): string {
  const path = projectId ? `/projects/${encodeURIComponent(projectId)}/settings` : "/settings";
  const query = new URLSearchParams({ section: "mcp", ...params });
  return `${path}?${query.toString()}`;
}

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  const state = query.get("state") ?? "";
  const code = query.get("code") ?? "";
  // The authorization server's own refusal — `access_denied` when somebody
  // pressed Cancel, which is a normal thing to do and not an error to shout at.
  const denied = query.get("error");

  if (denied) redirect(settingsUrl(undefined, { mcpOAuthError: query.get("error_description") || denied }));
  if (!state || !code) {
    redirect(settingsUrl(undefined, { mcpOAuthError: "That sign-in link was incomplete. Start it again from the server's row." }));
  }

  let outcome: { serverId: string; projectId?: string } | { error: string };
  try {
    outcome = await (await vnextEngine()).completeMcpOAuth({ state, code });
  } catch (error) {
    outcome = { error: error instanceof Error ? error.message : "The sign-in could not be completed." };
  }

  // The pending flow is single-use, so a failure here strands nothing: the row
  // is exactly as it was and Connect can be pressed again.
  if ("error" in outcome) redirect(settingsUrl(undefined, { mcpOAuthError: outcome.error }));
  redirect(settingsUrl(outcome.projectId, { mcpConnected: outcome.serverId }));
}
