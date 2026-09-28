import { enginePluginDoor, engineRoute, requestObject } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ plugin: string; verb: string[] }> };

/**
 * A plugin's Mac-wide verbs (`toolchain`, `bootstrap`, `jobs/:id`…), forwarded
 * with their query and, for a POST, their body. Scoped to the engine this
 * request resolves to, like `GET /api/plugins` beside it.
 */
const forward = (method: "GET" | "POST" | "DELETE") => engineRoute(async (request: Request, context: Context) => {
  const { plugin, verb } = await context.params;
  return enginePluginDoor("machine", plugin, verb, method, {
    search: new URL(request.url).search,
    ...(method === "POST" ? { body: await requestObject(request) } : {}),
  });
});

export const GET = forward("GET");
export const POST = forward("POST");
export const DELETE = forward("DELETE");
