/**
 * The paired-browser cookie. `Secure` is CONDITIONAL on the request having
 * arrived over HTTPS (tailscale serve sets x-forwarded-proto): an
 * unconditional Secure would be silently dropped on the plain-http tailnet-IP
 * origin — the primary dogfood path — and pairing would appear to succeed and
 * then do nothing. Cookies are per-origin: pairing at the tailnet IP does not
 * pair the same browser at the ts.net name.
 */
export const DEVICE_COOKIE = "telar_device";

export function deviceCookieHeader(raw: string, request: Request): string {
  const https = request.headers.get("x-forwarded-proto") === "https";
  const base = `${DEVICE_COOKIE}=${raw}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`;
  return https ? `${base}; Secure` : base;
}
