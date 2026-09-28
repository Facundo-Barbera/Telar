import { engineClient, engineErrorResponse, requestObject } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ sessionId: string; plugin: string; verb: string[] }> };

/** One door to every plugin's session verbs — `ds/` and `latex/` generalised. Always a POST. */
export async function POST(request: Request, context: Context) {
  try {
    const { sessionId, plugin, verb } = await context.params;
    const body = await requestObject(request);
    return Response.json(
      await (await engineClient()).plugin(sessionId, encodeURIComponent(plugin), verb.map(encodeURIComponent).join("/"), body),
    );
  } catch (error) {
    return engineErrorResponse(error);
  }
}
