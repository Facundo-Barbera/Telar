import {
cockpitPort,
listEndpoints,
deviceCookieHeader,
readDeviceCookie,
identifyCaller,
isHostCaller,
readRemote,
describeDevice,
type DeviceIdentity,
machineName,
observeIdentity,
HOST_TOKEN_ENV,
readHostHeader,
} from "@/features/remote/server";
import { readServeError } from "@/features/remote";
import { engineRoute } from "@/platform/engine/server";
import { engineCall } from "@/platform/engine/server";

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

export const GET = engineRoute(async (request: Request) => {
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
});

export const PATCH = engineRoute(async (request: Request) => {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const turningOn = body.requireAuth === true && body.exposure === undefined && body.tailscaleServe === undefined;
  const identity = turningOn ? observeIdentity(request) : undefined;
  const answer = await engineCall("PATCH", "/v2/remote", identity ? { ...body, device: { name: describeDevice(identity), identity } } : body);
  const { deviceToken, ...visible } = answer.body as { deviceToken?: string };
  if (answer.status !== 200 || !deviceToken) return Response.json(visible, { status: answer.status });
  return Response.json(visible, { headers: { "set-cookie": deviceCookieHeader(deviceToken, request), "cache-control": "no-store" } });
});
