const DEVICE_COOKIE = "telar_device";

export function deviceCookieHeader(raw: string, request: Request): string {
  const https = request.headers.get("x-forwarded-proto") === "https";
  const base = `${DEVICE_COOKIE}=${raw}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`;
  return https ? `${base}; Secure` : base;
}

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
