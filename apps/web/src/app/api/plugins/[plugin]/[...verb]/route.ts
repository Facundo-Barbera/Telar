import { engineErrorResponse, enginePluginDoor, requestObject } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ plugin: string; verb: string[] }> };

/**
 * A plugin's Mac-wide verbs (`toolchain`, `bootstrap`, `jobs/:id`…), forwarded
 * with their query and, for a POST, their body. Scoped to the engine this
 * request resolves to, like `GET /api/plugins` beside it.
 */
async function forward(request: Request, context: Context, method: "GET" | "POST" | "DELETE") {
  try {
    const { plugin, verb } = await context.params;
    return await enginePluginDoor("machine", plugin, verb, method, {
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
