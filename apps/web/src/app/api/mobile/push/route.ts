import { identifyCaller } from "@/features/remote/server";
import { engineCall, engineForward, engineRoute } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const REGISTRATION_MAX_BYTES = 32768;

const caller = async (request: Request) => (await identifyCaller(request)).device;

const devicePath = (deviceId: string) => `/v2/push/devices/${encodeURIComponent(deviceId)}`;

export const GET = engineRoute(async (request: Request) => {
  const device = await caller(request);
  if (!device) return Response.json({ error: { message: "Pair this device first." } }, { status: 401 });
  return engineForward(request, devicePath(device.id));
});

export const PUT = engineRoute(async (request: Request) => {
  const device = await caller(request);
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
  const answer = await engineCall("PUT", devicePath(device.id), registration);
  return Response.json(answer.body, { status: answer.status });
});
