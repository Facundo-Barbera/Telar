import type { PluginInstallInput } from "@telar/engine-client";
import { engineClient, engineErrorResponse, requestObject } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Install a plugin from a folder on this Mac. The engine validates the manifest before writing anything. */
export async function POST(request: Request) {
  try {
    const input = await requestObject(request);
    return Response.json(await (await engineClient()).installPlugin(input as PluginInstallInput));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
