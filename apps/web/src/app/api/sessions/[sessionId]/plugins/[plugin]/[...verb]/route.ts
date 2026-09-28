import { engineClient, requestObject, engineRoute } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ sessionId: string; plugin: string; verb: string[] }> };

/** One door to every plugin's session verbs — `ds/` and `latex/` generalised. Always a POST. */
export const POST = engineRoute(async (request: Request, context: Context) => {
  const { sessionId, plugin, verb } = await context.params;
  const body = await requestObject(request);
  return Response.json(
    await (await engineClient()).plugin(sessionId, encodeURIComponent(plugin), verb.map(encodeURIComponent).join("/"), body),
  );
});
