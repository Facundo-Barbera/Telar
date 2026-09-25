import { readDeviceCookie } from "@/lib/remote/cookie";
import { identifyCaller } from "@/lib/remote/gate";
import { readRemote } from "@/lib/remote/store";
import { activityReport, parseRegistration, pushConfigured, PushInputError, readPushRecords, saveRegistration } from "@/lib/mobile/push";
import { sendRelayTest, startMobilePushWorker } from "@/lib/mobile/worker";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function caller(request: Request) {
  return identifyCaller({ authorization: request.headers.get("authorization"), deviceCookie: readDeviceCookie(request) }, readRemote());
}
/** What this Mac knows about the caller's automatic Live Activity, for the
 *  phone's Settings to say WHY a card has or has not appeared. */
function activityFor(deviceId: string, topic?: string) {
  const record = readPushRecords().find(r => r.deviceId === deviceId && (topic === undefined || r.topic === topic));
  return record ? { activity: activityReport(record) } : {};
}
export function GET(request: Request) {
  const device = caller(request);
  if (!device) return Response.json({ error: { message: "Pair this device first." } }, { status: 401 });
  return Response.json({ configured: pushConfigured(), ...activityFor(device.id) });
}
export async function PUT(request: Request) {
  const device = caller(request);
  if (!device) return Response.json({ error: { message: "Pair this device first." } }, { status: 401 });
  if (device.role !== "full") return Response.json({ error: { message: "Full access is required." } }, { status: 403 });
  // Bound reads even when Content-Length is missing or untrusted.
  const reader = request.body?.getReader();
  if (!reader) return Response.json({ error: { message: "Missing registration." } }, { status: 400 });
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > 32768) { await reader.cancel(); return Response.json({ error: { message: "Registration too large." } }, { status: 413 }); }
      chunks.push(value);
    }
    const registration = parseRegistration(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    saveRegistration(device.id, registration);
    startMobilePushWorker();
    // Not awaited: the phone is not kept waiting on APNs to hear it registered.
    if (registration.relay) void sendRelayTest(device.id, registration.topic);
    // A phone that brought a relay v2 credential needs nothing from this Mac.
    return Response.json({ configured: registration.relay !== undefined || pushConfigured(registration.sandbox), ...activityFor(device.id, registration.topic) });
  } catch (error) {
    if (error instanceof PushInputError || error instanceof SyntaxError) return Response.json({ error: { message: "Invalid push registration." } }, { status: 400 });
    return Response.json({ error: { message: "Couldn't save push registration." } }, { status: 503 });
  }
}
