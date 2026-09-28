import { cockpitPort, listEndpoints } from "@/features/remote/server";
import { encodeQr, type QrMatrix } from "@/features/remote";
import { engineErrorResponse } from "@/platform/engine/server";
import { engineCall, engineForward } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  try {
    const { code, expiresAt } = (await engineCall("POST", "/v2/remote/pairing")).body as { code: string; expiresAt: number };
    const qrByUrl: Record<string, QrMatrix> = {};
    for (const endpoint of listEndpoints(cockpitPort())) {
      if (endpoint.qrSafe) qrByUrl[endpoint.url] = encodeQr(`${endpoint.url}/pair#token=${code}`);
    }
    return Response.json({ code, expiresAt, qrByUrl }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return engineErrorResponse(error);
  }
}

export function DELETE(request: Request) {
  return engineForward(request, "/v2/remote/pairing");
}
