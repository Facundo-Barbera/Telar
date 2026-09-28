import type { PluginInstallInput } from "@telar/engine-client";
import { engineClient, requestObject, engineRoute } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Install a plugin from a folder on this Mac. The engine validates the manifest before writing anything. */
export const POST = engineRoute(async (request: Request) => {
  const input = await requestObject(request);
  return Response.json(await (await engineClient()).installPlugin(input as PluginInstallInput));
});
