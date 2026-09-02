import { listEndpoints } from "@/lib/remote/endpoints";
import { deviceCookieHeader, readDeviceCookie } from "@/lib/remote/cookie";
import { identifyCaller } from "@/lib/remote/gate";
import { remoteErrorResponse } from "@/lib/remote/http";
import { addDevice, mintDeviceToken, readRemote, setRequireAuth, setExposure } from "@/lib/remote/store";
import { describeDevice, type DeviceIdentity } from "@/lib/remote/identity";
import { machineName, observeIdentity } from "@/lib/remote/observe";
import { HOST_TOKEN_ENV, isHostToken } from "@/lib/remote/host-token";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function webPort(): number {
  const raw = Number(process.env.PORT ?? process.env.TELAR_WEB_PORT ?? 3000);
  return Number.isInteger(raw) && raw > 0 ? raw : 3000;
}

const OS_NAMES: Record<string, string> = { darwin: "macOS", win32: "Windows", linux: "Linux" };

/**
 * THE PROCESS THAT RUNS THE SERVER, AS A ROW.
 *
 * It holds a per-launch secret instead of a device record (host-token.ts), and
 * the consequence was that the app doing the hosting — the one thing certain to
 * be connected — appeared nowhere in a panel whose entire job is naming what is
 * connected. So it is reported, not stored: derived fresh from this process
 * every read, absent when nothing launched us (a bare `next dev`), and carrying
 * no id because there is nothing to revoke. Quitting the shell is the revoke.
 */
function hostRow(): { name: string; identity: DeviceIdentity } | undefined {
  if (!process.env[HOST_TOKEN_ENV]) return undefined;
  const identity: DeviceIdentity = {
    kind: "desktop",
    client: process.env.TELAR_HOST_CLIENT?.trim() || "Telar",
    ...(machineName() ? { machine: machineName() } : {}),
    ...(OS_NAMES[process.platform] ? { os: OS_NAMES[process.platform] } : {}),
  };
  return { name: describeDevice(identity), identity };
}

/** The Remote access panel's whole state. Hashes never leave the store.
 *  callerDeviceId lets both surfaces badge "This device" without any client
 *  ever needing to remember its own id. */
export function GET(request: Request) {
  try {
    const file = readRemote();
    const cookie = readDeviceCookie(request);
    const caller = identifyCaller({ authorization: request.headers.get("authorization"), deviceCookie: cookie }, file);
    const host = hostRow();
    return Response.json({
      // Present only when a shell launched this server, and flagged as the
      // caller when this very request carries the host secret.
      host: host ? { ...host, isCaller: isHostToken(cookie) } : undefined,
      requireAuth: file.requireAuth,
      exposure: file.exposure ?? "local-only",
      devices: file.devices.map(({ id, name, createdAt, lastSeenAt, role, platform, identity }) => ({
        id,
        name,
        createdAt,
        lastSeenAt,
        role,
        platform,
        // The report-back fields. `tokenHash` is the one member that never
        // leaves the store, which is why this is a pick rather than a spread.
        identity,
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
    /**
     * NAMED THE SAME WAY A PAIRED DEVICE IS. This row used to be the literal
     * string "This browser" with no identity at all, which made the one device
     * guaranteed to be in every list the single least identifiable entry in it
     * — no client, no machine, no address to tell it from the next tab.
     */
    const deviceToken = mintDeviceToken();
    const identity = observeIdentity(request);
    const device = addDevice(describeDevice(identity), deviceToken, { identity });
    setRequireAuth(true);
    return Response.json(
      { requireAuth: true, device: { id: device.id, name: device.name } },
      { headers: { "set-cookie": deviceCookieHeader(deviceToken, request), "cache-control": "no-store" } },
    );
  } catch (error) {
    return remoteErrorResponse(error);
  }
}
