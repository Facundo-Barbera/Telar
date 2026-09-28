import { readDeviceCookie, identifyCaller, readRemote } from "@/features/remote/server";
import { engineErrorResponse } from "@/platform/engine/server";
import { engineCall } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const REGISTRATION_MAX_BYTES = 32768;

function caller(request: Request) {
  return identifyCaller({ authorization: request.headers.get("authorization"), deviceCookie: readDeviceCookie(request) }, readRemote());
}

const devicePath = (deviceId: string) => `/v2/push/devices/${encodeURIComponent(deviceId)}`;

async function relay(method: string, path: string, body?: unknown): Promise<Response> {
  try {
    const answer = await engineCall(method, path, body);
    return Response.json(answer.body, { status: answer.status });
  } catch (error) {
    return engineErrorResponse(error);
  }
}

export function GET(request: Request) {
  const device = caller(request);
  if (!device) return Response.json({ error: { message: "Pair this device first." } }, { status: 401 });
  return relay("GET", devicePath(device.id));
}

export async function PUT(request: Request) {
  const device = caller(request);
  if (!device) return Response.json({ error: { message: "Pair this device first." } }, { status: 401 });
  if (device.role !== "full") return Response.json({ error: { message: "Full access is required." } }, { status: 403 });
  const reader = request.body?.getReader();
  if (!reader) return Response.json({ error: { message: "Missing registration." } }, { status: 400 });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > REGISTRATION_MAX_BYTES) {
      await reader.cancel();
      return Response.json({ error: { message: "Registration too large." } }, { status: 413 });
    }
    chunks.push(value);
  }
  let registration: unknown;
  try {
    registration = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return Response.json({ error: { message: "Invalid push registration." } }, { status: 400 });
  }
  return relay("PUT", devicePath(device.id), registration);
}
