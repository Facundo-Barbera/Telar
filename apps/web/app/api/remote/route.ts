import { listEndpoints } from "@/lib/remote/endpoints";
import { deviceCookieHeader, readDeviceCookie } from "@/lib/remote/cookie";
import { identifyCaller } from "@/lib/remote/gate";
import { remoteErrorResponse } from "@/lib/remote/http";
import { addDevice, mintDeviceToken, readRemote, setRequireAuth, setExposure } from "@/lib/remote/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function webPort(): number {
  const raw = Number(process.env.PORT ?? process.env.TELAR_WEB_PORT ?? 3000);
  return Number.isInteger(raw) && raw > 0 ? raw : 3000;
}

/** The Remote access panel's whole state. Hashes never leave the store.
 *  callerDeviceId lets both surfaces badge "This device" without any client
 *  ever needing to remember its own id. */
export function GET(request: Request) {
  try {
    const file = readRemote();
    const caller = identifyCaller(
      { authorization: request.headers.get("authorization"), deviceCookie: readDeviceCookie(request) },
      file,
    );
    return Response.json({
      requireAuth: file.requireAuth,
      exposure: file.exposure ?? "local-only",
      devices: file.devices.map(({ id, name, createdAt, lastSeenAt, role, platform }) => ({
        id,
        name,
        createdAt,
        lastSeenAt,
        role,
        platform,
      })),
      callerDeviceId: caller?.id,
      callerRole: caller?.role,
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
    const body = (await request.json()) as { requireAuth?: unknown; exposure?: unknown };

    /**
     * WHERE THE SOCKET LISTENS is its own decision, taken separately from
     * whether the gate is on — one PATCH, two fields, because a caller that
     * meant to widen the bind must not have to restate the auth flag and risk
     * turning it off by omission.
     *
     * The shell only reads this at launch, so the answer says a restart is
     * needed rather than pretending the change already took.
     */
    if (body.exposure !== undefined) {
      if (body.exposure !== "local-only" && body.exposure !== "network-accessible") {
        return Response.json({ error: { code: "invalid_request", message: "exposure must be local-only or network-accessible." } }, { status: 400 });
      }
      try {
        const file = setExposure(body.exposure);
        return Response.json({ exposure: file.exposure, restartRequired: true });
      } catch (cause) {
        return Response.json(
          { error: { code: "invalid_request", message: cause instanceof Error ? cause.message : "that exposure could not be set." } },
          { status: 400 },
        );
      }
    }

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
    const device = addDevice("This browser", deviceToken, { platform: "browser" });
    setRequireAuth(true);
    return Response.json(
      { requireAuth: true, device: { id: device.id, name: device.name } },
      { headers: { "set-cookie": deviceCookieHeader(deviceToken, request), "cache-control": "no-store" } },
    );
  } catch (error) {
    return remoteErrorResponse(error);
  }
}
