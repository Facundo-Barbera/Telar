import type { McpOAuthStatus } from "@telar/engine-client";

export const HEALTH_DOT: Record<McpOAuthStatus["health"], string> = {
  connected: "bg-success",
  "needs-auth": "bg-warning",
  error: "bg-destructive",
  unknown: "bg-muted-foreground/40",
};

export type SignInAction = "connect" | "reconnect" | "disconnect" | "none";

export function signInAction(status: McpOAuthStatus | undefined): SignInAction {
  if (!status) return "none";
  if (status.connected) return status.health === "needs-auth" ? "reconnect" : "disconnect";
  return status.requiresOAuth ? "connect" : "none";
}

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

function expirySuffix(expiresAt: number | undefined, now: number): string {
  if (expiresAt === undefined) return "";
  const remaining = expiresAt - now;
  if (remaining <= 0) return ", and the token has expired";
  if (remaining > 60 * 60_000) return "";
  const minutes = Math.max(1, Math.round(remaining / 60_000));
  return `, renewing in ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export function statusFor(
  statuses: readonly McpOAuthStatus[],
  server: { id: string; projectId?: string },
): McpOAuthStatus | undefined {
  return statuses.find((status) => status.serverId === server.id && status.projectId === server.projectId);
}
