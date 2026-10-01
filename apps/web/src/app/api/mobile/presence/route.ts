import { identifyCaller } from "@/features/remote/server";
import { engineForward, engineRoute } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const PUT = engineRoute(async (request: Request) => {
  const { device } = await identifyCaller(request);
  if (!device) return Response.json({ error: { message: "Pair this device first." } }, { status: 401 });
  return engineForward(request, `/v2/push/desktop/presence/${encodeURIComponent(device.id)}`);
});
