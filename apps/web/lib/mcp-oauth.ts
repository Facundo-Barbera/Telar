/**
 * What a server's sign-in row SAYS, and which button it offers — with no React
 * in it.
 *
 * A module rather than inline JSX for the reason the Providers pane's is one:
 * "does this row need a login" is a DECISION over four independent facts, and a
 * decision made inside a render function is one nothing can test and two
 * surfaces can spell differently.
 *
 * THE FOUR FACTS DO NOT COLLAPSE. `requiresOAuth` is what the server asks for,
 * `connected` is whether a grant is stored, `health` is whether it currently
 * works, and `expiresAt` is when it stops. Every wrong summary here sends
 * somebody to fix the wrong thing — the specific failure worth naming is a
 * server that is merely DOWN rendering as one that needs a login, because those
 * two want opposite actions and only one of them is the reader's to take.
 */
import type { McpOAuthStatus } from "@telar/engine-client";

/** On the five-token vocabulary (app/globals.css), never a raw Tailwind ramp,
 *  so this dot and a badge elsewhere cannot disagree about what amber means. */
export const HEALTH_DOT: Record<McpOAuthStatus["health"], string> = {
  connected: "bg-success",
  "needs-auth": "bg-warning",
  error: "bg-destructive",
  unknown: "bg-muted-foreground/40",
};

export type SignInAction = "connect" | "reconnect" | "disconnect" | "none";

/**
 * WHICH BUTTON, if any.
 *
 * `disconnect` WINS OVER `reconnect` ON A HEALTHY CONNECTED SERVER, and the
 * pane offers reconnect beside it rather than instead of it — re-running a
 * working sign-in is a legitimate thing to want (a different account, a wider
 * scope) but it is not the primary action on a row that is fine.
 *
 * A SERVER THAT NEEDS NO OAUTH AND HAS NO GRANT GETS NO BUTTON. Offering
 * Connect on a server that never asked for it produces a flow that fails at
 * discovery, and a button that cannot work is worse than no button.
 */
export function signInAction(status: McpOAuthStatus | undefined): SignInAction {
  if (!status) return "none";
  if (status.connected) return status.health === "needs-auth" ? "reconnect" : "disconnect";
  return status.requiresOAuth ? "connect" : "none";
}

/**
 * The sentence under the row, ORDERED BY WHAT THE READER SHOULD DO FIRST.
 *
 * "Signed in but the server is unreachable" outranks the expiry, because a
 * countdown on a server nobody can reach is answering a question that is not
 * being asked.
 */
export function signInSummary(status: McpOAuthStatus | undefined, now = Date.now()): string {
  if (!status) return "Checking this server…";
  if (!status.connected) {
    if (!status.requiresOAuth) {
      return status.health === "error"
        ? "No sign-in needed — but the server did not answer."
        : "No sign-in needed.";
    }
    return "This server wants a login. Telar will run it in your browser.";
  }
  if (status.health === "error") return `Signed in${issuerSuffix(status)} — but the server did not answer.`;
  if (status.health === "needs-auth") return `The stored login is no longer accepted${issuerSuffix(status)}. Sign in again.`;
  return `Signed in${issuerSuffix(status)}${expirySuffix(status.expiresAt, now)}.`;
}

function issuerSuffix(status: McpOAuthStatus): string {
  if (!status.issuer) return "";
  try {
    return ` through ${new URL(status.issuer).host}`;
  } catch {
    return ` through ${status.issuer}`;
  }
}

/**
 * ONLY SHOWN WHEN IT IS ACTUALLY NEWS.
 *
 * A token refreshed automatically before every turn, so an expiry an hour out
 * is not something to warn about — printing one would train people to ignore
 * the line by the time it means something. Under an hour it is worth saying;
 * already past, it says so plainly rather than counting negative minutes.
 */
function expirySuffix(expiresAt: number | undefined, now: number): string {
  if (expiresAt === undefined) return "";
  const remaining = expiresAt - now;
  if (remaining <= 0) return ", and the token has expired";
  if (remaining > 60 * 60_000) return "";
  const minutes = Math.max(1, Math.round(remaining / 60_000));
  return `, renewing in ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** Match a status to a server, on the same `(projectId, serverId)` pair the
 *  engine keys grants by — an id-only match would show a project server the
 *  machine-wide server's login. */
export function statusFor(
  statuses: readonly McpOAuthStatus[],
  server: { id: string; projectId?: string },
): McpOAuthStatus | undefined {
  return statuses.find((status) => status.serverId === server.id && status.projectId === server.projectId);
}
