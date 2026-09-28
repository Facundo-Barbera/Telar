/**
 * WHY THE ts.net URL IS NOT THERE — issue #627.
 *
 * Turning on "Tailscale HTTPS" and restarting used to have exactly two visible
 * outcomes: a URL, or nothing. The nothing had four different causes, each with
 * a different thing to do about it, and all four ended at a `console.error` in
 * the desktop shell that no user will ever read. The pane said "Publishes at
 * the next launch" for ever, and the person concluded remote access was broken.
 *
 * THE LABEL IS ALREADY COMPUTED. `apps/desktop/tailscale.js` classifies the
 * failure and returns a bare enum word — never raw stderr, which can carry
 * `tskey-…` auth keys. The shell passes that word to this process in the
 * environment, beside `TELAR_TAILSCALE_URL` and for the same reason: the
 * Remote access pane is what has to say it.
 *
 * A LABEL, NOT A SENTENCE, crosses the boundary — so the wording lives here
 * with the pane that shows it, and an unrecognised word (an older shell, a new
 * classification) degrades to a truthful generic rather than to nothing.
 */

export const TAILSCALE_SERVE_ERROR_ENV = "TELAR_TAILSCALE_SERVE_ERROR";

/** The shell's classifications, plus `no-cert-domain` for the case where
 *  `tailscale status` reports no HTTPS-capable name at all — which is the same
 *  answer for three different causes, so its sentence names all three. */
export type TailscaleServeError =
  | "no-cert-domain"
  | "https-disabled"
  | "not-installed"
  | "not-logged-in"
  | "permission-denied"
  | "unknown";

/** What happened, and the one thing to do about it. Kept to a sentence each:
 *  this renders as a hint under a toggle, not as a troubleshooting page. */
const EXPLANATIONS: Record<TailscaleServeError, string> = {
  "no-cert-domain":
    "Tailscale did not offer an HTTPS name at the last launch — it is not installed, not running, or HTTPS certificates are off for your tailnet. Enable HTTPS in the Tailscale admin console under DNS, then restart Telar.",
  "https-disabled":
    "Your tailnet has HTTPS certificates turned off, so there is no name to serve. Enable HTTPS in the Tailscale admin console under DNS, then restart Telar.",
  "not-installed": "Tailscale is not installed on this Mac, so there is nothing to publish through.",
  "not-logged-in": "Tailscale is installed but logged out. Sign in, then restart Telar.",
  "permission-denied": "Tailscale refused the request. Open the Tailscale app once and allow it, then restart Telar.",
  unknown: "Tailscale refused to publish and did not say why. Check that it is running and signed in, then restart Telar.",
};

function isKnown(value: string): value is TailscaleServeError {
  return value in EXPLANATIONS;
}

/** The label the shell reported, or undefined — absent means either "it
 *  worked" or "nothing asked for it", and the pane can tell those apart from
 *  the endpoint list. */
export function readServeError(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): TailscaleServeError | undefined {
  const raw = env[TAILSCALE_SERVE_ERROR_ENV]?.trim();
  if (!raw) return undefined;
  // An unrecognised word is still a failure — report it as one rather than
  // dropping it, which would put the pane back where it started.
  return isKnown(raw) ? raw : "unknown";
}

export function describeServeError(error: TailscaleServeError): string {
  return EXPLANATIONS[error];
}
