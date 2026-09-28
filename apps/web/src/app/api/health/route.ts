import { engineClient, engineRoute } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = engineRoute(async () => {
  return Response.json(await (await engineClient()).health());
});
