import { addDevice, consumePairing, mintDeviceToken, RemoteStoreError, type PairingRefusal } from "@/lib/remote/store";
import { cleanDeclared, describeDevice, isDeviceKind, sniffUserAgent, type DeviceIdentity } from "@/lib/remote/identity";

/**
 * THE PEER ADDRESS, from whichever header this deployment actually sets. Next
 * does not expose the socket, and the cockpit sits behind its own proxy, so
 * the forwarded chain is the only source — first hop, because the ones after
 * it are whatever the client felt like appending.
 */
function peerAddress(request: Request): string | undefined {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const candidate = forwarded || request.headers.get("x-real-ip")?.trim();
  return candidate && candidate.length <= 64 ? candidate : undefined;
}

/** Which origin it paired against — pairing is per-origin, so this is how a
 *  reader tells a loopback pairing from a tailnet one for the same machine. */
function originOf(request: Request): string | undefined {
  try {
    return new URL(request.url).host.slice(0, 64) || undefined;
  } catch {
    return undefined;
  }
}

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
   * WHAT IT SAYS IT IS, AND WHAT WE SAW.
   *
   * Declared fields are believed and merely bounded — a native client knows
   * its own name and a browser does not. The User-Agent fallback fills only
   * what nothing declared, so a CLI that introduces itself is never overruled
   * by a header it did not set.
   *
   * The address and origin are OBSERVED. A caller cannot claim to have
   * connected from somewhere it did not, which is what makes them the fields
   * worth trusting when two rows look alike.
   */
  const sniffed = sniffUserAgent(request.headers.get("user-agent"));
  const declaredKind = isDeviceKind(body.kind) ? body.kind : undefined;
  const identity: DeviceIdentity = {
    kind: declaredKind ?? (platform === "ios" ? "phone" : sniffed.kind),
    ...(cleanDeclared(body.client) ?? sniffed.client ? { client: cleanDeclared(body.client) ?? sniffed.client } : {}),
    ...(cleanDeclared(body.machine) ? { machine: cleanDeclared(body.machine) } : {}),
    ...(cleanDeclared(body.os) ?? sniffed.os ? { os: cleanDeclared(body.os) ?? sniffed.os } : {}),
    ...(peerAddress(request) ? { address: peerAddress(request) } : {}),
    ...(originOf(request) ? { origin: originOf(request) } : {}),
  };
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
