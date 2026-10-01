
export const TAILSCALE_SERVE_ERROR_ENV = "TELAR_TAILSCALE_SERVE_ERROR";

export type TailscaleServeError =
  | "no-cert-domain"
  | "https-disabled"
  | "not-installed"
  | "not-logged-in"
  | "permission-denied"
  | "unknown";

const EXPLANATIONS: Record<TailscaleServeError, string> = {
  "no-cert-domain":
    "Tailscale did not offer an HTTPS name at the last launch — it is not installed, not running, or HTTPS certificates are off for your tailnet. Enable HTTPS in the Tailscale admin console under DNS, then restart Telar.",
  "https-disabled":
    "Your tailnet has HTTPS certificates turned off, so there is no name to serve. Enable HTTPS in the Tailscale admin console under DNS, then restart Telar.",
  "not-installed": "Tailscale is not installed on this computer, so there is nothing to publish through.",
  "not-logged-in": "Tailscale is installed but logged out. Sign in, then restart Telar.",
  "permission-denied": "Tailscale refused the request. Open the Tailscale app once and allow it, then restart Telar.",
  unknown: "Tailscale refused to publish and did not say why. Check that it is running and signed in, then restart Telar.",
};

function isKnown(value: string): value is TailscaleServeError {
  return value in EXPLANATIONS;
}

export function readServeError(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): TailscaleServeError | undefined {
  const raw = env[TAILSCALE_SERVE_ERROR_ENV]?.trim();
  if (!raw) return undefined;
  return isKnown(raw) ? raw : "unknown";
}

export function describeServeError(error: TailscaleServeError): string {
  return EXPLANATIONS[error];
}
