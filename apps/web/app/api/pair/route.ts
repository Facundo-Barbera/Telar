import { addDevice, consumePairing, mintDeviceToken, RemoteStoreError, type PairingRefusal } from "@/lib/remote/store";
import { describeDevice } from "@/lib/remote/identity";
import { observeIdentity } from "@/lib/remote/observe";

/**
 * WHY IT WAS REFUSED, in words a person can act on. Every refusal used to read
 * "expired or already used", which is the wrong advice for two of the three
 * causes — and "generate a fresh code" does not help at all when the code came
 * from a different cockpit.
 */
const REFUSAL: Record<PairingRefusal, string> = {
  "none-pending": "No pairing code is waiting. Generate one in Settings → Remote access — a code is single-use, so one that already paired a device is spent.",
  expired: "That pairing code has expired. They last five minutes; generate a fresh one.",
  mismatch: "That is not the pending pairing code. Check the digits — or, if you have more than one Telar running, generate the code from the same one you are pairing against.",
  burned: "Too many wrong tries; that pairing code has been destroyed. Generate a fresh one in Settings → Remote access.",
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
  let body: { token?: unknown; deviceName?: unknown; platform?: unknown; kind?: unknown; client?: unknown; machine?: unknown; os?: unknown };
  try {
    const text = await request.text();
    if (text.length > 1024) throw new Error("too large");
    body = JSON.parse(text) as typeof body;
  } catch {
    return Response.json(
      { error: { code: "invalid_request", message: "Request body must be a small JSON object." } },
      { status: 400 },
    );
  }
  const token = typeof body.token === "string" ? body.token : "";
  const platform = body.platform === "ios" || body.platform === "browser" ? body.platform : undefined;

  /**
   * WHAT IT SAYS IT IS, AND WHAT WE SAW — see lib/remote/observe.ts.
   *
   * `kind` is a free slug: a client called Lintel declares `kind: "lintel"`
   * and the row says Lintel. The retired `platform: "ios"` is still honoured
   * for clients built against the old shape, but only as a default the new
   * field overrides.
   */
  const identity = observeIdentity(request, {
    kind: body.kind ?? (platform === "ios" ? "phone" : undefined),
    client: body.client,
    machine: body.machine,
    os: body.os,
  });
  const deviceName = describeDevice(identity, typeof body.deviceName === "string" ? body.deviceName : undefined);
  try {
    const outcome = token ? consumePairing(token) : "none-pending";
    if (outcome !== true) {
      return Response.json(
        { error: { code: "cockpit_unauthorized", message: REFUSAL[outcome] } },
        { status: 401, headers: { "cache-control": "no-store" } },
      );
    }
    const deviceToken = mintDeviceToken();
    const device = addDevice(deviceName, deviceToken, { ...(platform ? { platform } : {}), identity });
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
