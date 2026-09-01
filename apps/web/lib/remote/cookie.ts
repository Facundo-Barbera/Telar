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

/** The raw device token off a plain Request's cookie header (route handlers
 *  don't get NextRequest.cookies). */
export function readDeviceCookie(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === DEVICE_COOKIE) return part.slice(eq + 1).trim() || null;
  }
  return null;
}
