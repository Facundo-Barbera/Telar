import { engineErrorResponse, enginePluginDoor, requestObject } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string; plugin: string; verb: string[] }> };

/**
 * A plugin's project verbs (`environments`, `packages`, `jobs/:id`…), forwarded
 * with their query and, for a POST, their body. Which verbs exist, and whether
 * one answers before the project turns the plugin on, is the engine's.
 */
async function forward(request: Request, context: Context, method: "GET" | "POST" | "DELETE") {
  try {
    const { projectId, plugin, verb } = await context.params;
    return await enginePluginDoor({ projectId }, plugin, verb, method, {
      search: new URL(request.url).search,
      ...(method === "POST" ? { body: await requestObject(request) } : {}),
    });
  } catch (error) {
    return engineErrorResponse(error);
  }
}

export const GET = (request: Request, context: Context) => forward(request, context, "GET");
export const POST = (request: Request, context: Context) => forward(request, context, "POST");
export const DELETE = (request: Request, context: Context) => forward(request, context, "DELETE");
