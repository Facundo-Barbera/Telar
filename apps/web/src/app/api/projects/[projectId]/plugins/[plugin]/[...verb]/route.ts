import { enginePluginDoor, engineRoute, requestObject } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string; plugin: string; verb: string[] }> };

/**
 * A plugin's project verbs (`environments`, `packages`, `jobs/:id`…), forwarded
 * with their query and, for a POST, their body. Which verbs exist, and whether
 * one answers before the project turns the plugin on, is the engine's.
 */
const forward = (method: "GET" | "POST" | "DELETE") => engineRoute(async (request: Request, context: Context) => {
  const { projectId, plugin, verb } = await context.params;
  return enginePluginDoor({ projectId }, plugin, verb, method, {
    search: new URL(request.url).search,
    ...(method === "POST" ? { body: await requestObject(request) } : {}),
  });
});

export const GET = forward("GET");
export const POST = forward("POST");
export const DELETE = forward("DELETE");
