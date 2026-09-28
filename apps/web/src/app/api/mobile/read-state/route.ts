import { identifyCaller } from "@/features/remote/server";
import { engineForward } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const { device } = await identifyCaller(request);
  if (!device) return Response.json({ error: { message: "Pair this device first." } }, { status: 401 });
  const ids = new URL(request.url).searchParams.get("ids");
  return engineForward(request, `/v2/push/read-state${ids === null ? "" : `?ids=${encodeURIComponent(ids)}`}`);
}
