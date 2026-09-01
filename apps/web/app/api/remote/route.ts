import { listEndpoints } from "@/lib/remote/endpoints";
import { deviceCookieHeader } from "@/lib/remote/cookie";
import { remoteErrorResponse } from "@/lib/remote/http";
import { addDevice, mintDeviceToken, readRemote, setRequireAuth } from "@/lib/remote/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function webPort(): number {
  const raw = Number(process.env.PORT ?? process.env.TELAR_WEB_PORT ?? 3000);
  return Number.isInteger(raw) && raw > 0 ? raw : 3000;
}

/** The Remote access panel's whole state. Hashes never leave the store. */
export function GET() {
  try {
    const file = readRemote();
    return Response.json({
      requireAuth: file.requireAuth,
      devices: file.devices.map(({ id, name, createdAt, lastSeenAt }) => ({ id, name, createdAt, lastSeenAt })),
      pairing: file.pairing ? { expiresAt: file.pairing.expiresAt } : undefined,
      endpoints: listEndpoints(webPort()),
    });
  } catch (error) {
    return remoteErrorResponse(error);
  }
}

/**
 * Flip requireAuth. ENABLING PAIRS THE CALLING BROWSER IN THE SAME RESPONSE
 * — the anti-lockout guarantee. Two calls (enable, then pair) would leave a
 * window where the browser that flipped the switch is itself locked out.
 */
export async function PATCH(request: Request) {
  try {
    const body = (await request.json()) as { requireAuth?: unknown };
    if (typeof body.requireAuth !== "boolean") {
      return Response.json(
        { error: { code: "invalid_request", message: "requireAuth must be a boolean." } },
        { status: 400 },
      );
    }
    if (!body.requireAuth) {
      setRequireAuth(false);
      return Response.json({ requireAuth: false });
    }
    const deviceToken = mintDeviceToken();
    const device = addDevice("This browser", deviceToken);
    setRequireAuth(true);
    return Response.json(
      { requireAuth: true, device: { id: device.id, name: device.name } },
      { headers: { "set-cookie": deviceCookieHeader(deviceToken, request), "cache-control": "no-store" } },
    );
  } catch (error) {
    return remoteErrorResponse(error);
  }
}
