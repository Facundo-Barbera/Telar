import { addDevice, consumePairing, mintDeviceToken, RemoteStoreError } from "@/lib/remote/store";
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
  let body: { token?: unknown; deviceName?: unknown };
  try {
    const text = await request.text();
    if (text.length > 1024) throw new Error("too large");
    body = JSON.parse(text) as { token?: unknown; deviceName?: unknown };
  } catch {
    return Response.json(
      { error: { code: "invalid_request", message: "Request body must be a small JSON object." } },
      { status: 400 },
    );
  }
  const token = typeof body.token === "string" ? body.token : "";
  const deviceName = typeof body.deviceName === "string" ? body.deviceName : "";
  try {
    if (!token || !consumePairing(token)) {
      return Response.json(
        { error: { code: "cockpit_unauthorized", message: "That pairing code has expired or was already used." } },
        { status: 401, headers: { "cache-control": "no-store" } },
      );
    }
    const deviceToken = mintDeviceToken();
    const device = addDevice(deviceName || "Unnamed device", deviceToken);
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
