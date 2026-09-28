import { cockpitPort, listEndpoints } from "@/lib/remote/endpoints";
import { deviceCookieHeader, readDeviceCookie } from "@/lib/remote/cookie";
import { identifyCaller, isHostCaller } from "@/lib/remote/gate";
import { readRemote } from "@/lib/remote/store";
import { describeDevice, type DeviceIdentity } from "@/lib/remote/identity";
import { machineName, observeIdentity } from "@/lib/remote/observe";
import { HOST_TOKEN_ENV, readHostHeader } from "@/lib/remote/host-token";
import { readServeError } from "@/lib/remote/tailscale-serve";
import { engineErrorResponse } from "@/lib/engine/engine-server";
import { engineCall } from "@/lib/engine/forward";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const OS_NAMES: Record<string, string> = { darwin: "macOS", win32: "Windows", linux: "Linux" };

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

export async function GET(request: Request) {
  try {
    const remote = (await engineCall("GET", "/v2/remote")).body as Record<string, unknown>;
    const credentials = {
      authorization: request.headers.get("authorization"),
      deviceCookie: readDeviceCookie(request),
      hostHeader: readHostHeader(request),
    };
    const caller = identifyCaller(credentials, readRemote());
    const host = hostRow();
    return Response.json({
      ...remote,
      host: host ? { ...host, isCaller: isHostCaller(credentials) } : undefined,
      tailscaleServeError: readServeError(),
      callerDeviceId: caller?.id,
      callerRole: caller?.role,
      endpoints: listEndpoints(cockpitPort()),
    });
  } catch (error) {
    return engineErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const turningOn = body.requireAuth === true && body.exposure === undefined && body.tailscaleServe === undefined;
    const identity = turningOn ? observeIdentity(request) : undefined;
    const answer = await engineCall("PATCH", "/v2/remote", identity ? { ...body, device: { name: describeDevice(identity), identity } } : body);
    const { deviceToken, ...visible } = answer.body as { deviceToken?: string };
    if (answer.status !== 200 || !deviceToken) return Response.json(visible, { status: answer.status });
    return Response.json(visible, { headers: { "set-cookie": deviceCookieHeader(deviceToken, request), "cache-control": "no-store" } });
  } catch (error) {
    return engineErrorResponse(error);
  }
}
