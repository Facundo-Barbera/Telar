import { readDeviceCookie } from "@/lib/remote/cookie";
import { identifyCaller } from "@/lib/remote/gate";
import { readRemote } from "@/lib/remote/store";
import { engineForward } from "@/lib/engine/forward";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request) {
  const device = identifyCaller({ authorization: request.headers.get("authorization"), deviceCookie: readDeviceCookie(request) }, readRemote());
  if (!device) return Response.json({ error: { message: "Pair this device first." } }, { status: 401 });
  const ids = new URL(request.url).searchParams.get("ids");
  return engineForward(request, `/v2/push/read-state${ids === null ? "" : `?ids=${encodeURIComponent(ids)}`}`);
}
