import { addDevice, consumePairing, mintDeviceToken, RemoteStoreError, type PairingRefusal } from "@/lib/remote/store";

/**
 * WHY IT WAS REFUSED, in words a person can act on. Every refusal used to read
 * "expired or already used", which is the wrong advice for two of the three
 * causes — and "generate a fresh code" does not help at all when the code came
 * from a different cockpit.
 */
const REFUSAL: Record<PairingRefusal, string> = {
  "none-pending": "No pairing code is waiting. Generate one in Settings → Remote access — a code is single-use, so one that already paired a device is spent.",
  expired: "That pairing code has expired. They last ten minutes; generate a fresh one.",
  mismatch: "That pairing code was not issued by this cockpit. If you have more than one Telar running, generate the code from the same one you are pairing against.",
};
import { deviceCookieHeader } from "@/lib/remote/cookie";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The pairing exchange — the one gated-world route an UNPAIRED caller may
 * POST. A one-time pairing token (from the Remote access panel's QR) buys a
 * long-lived device token, returned once in the body for native clients and
 * set as a cookie for browsers.
 *
 * TOKENS NEVER TOUCH LOGS: they arrive in the JSON body (browsers carry them
 * only in a URL FRAGMENT, which never leaves the client), and nothing here
 * echoes them.
 */
export async function POST(request: Request) {
  let body: { token?: unknown; deviceName?: unknown; platform?: unknown };
  try {
    const text = await request.text();
    if (text.length > 1024) throw new Error("too large");
    body = JSON.parse(text) as { token?: unknown; deviceName?: unknown; platform?: unknown };
  } catch {
    return Response.json(
      { error: { code: "invalid_request", message: "Request body must be a small JSON object." } },
      { status: 400 },
    );
  }
  const token = typeof body.token === "string" ? body.token : "";
  const deviceName = typeof body.deviceName === "string" ? body.deviceName : "";
  // Self-declared, never sniffed from User-Agent; anything else stays unknown.
  const platform = body.platform === "ios" || body.platform === "browser" ? body.platform : undefined;
  try {
    const outcome = token ? consumePairing(token) : "none-pending";
    if (outcome !== true) {
      return Response.json(
        { error: { code: "cockpit_unauthorized", message: REFUSAL[outcome] } },
        { status: 401, headers: { "cache-control": "no-store" } },
      );
    }
    const deviceToken = mintDeviceToken();
    const device = addDevice(deviceName || "Unnamed device", deviceToken, { platform });
    return Response.json(
      { deviceToken, deviceId: device.id, deviceName: device.name },
      {
        status: 200,
        headers: { "set-cookie": deviceCookieHeader(deviceToken, request), "cache-control": "no-store" },
      },
    );
  } catch (error) {
    if (error instanceof RemoteStoreError) {
      return Response.json({ error: { code: "engine_unavailable", message: error.message } }, { status: 503 });
    }
    return Response.json({ error: { code: "internal_error", message: "Pairing failed." } }, { status: 500 });
  }
}
