import { engineClient, requestObject, engineRoute } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ sessionId: string; method: string[] }> };

/** One door to the session's kernel — `ds/<method>` forwarded verbatim. */
export const POST = engineRoute(async (request: Request, context: Context) => {
  const { sessionId, method } = await context.params;
  const body = await requestObject(request);
  return Response.json(await (await engineClient()).ds(sessionId, method.join("/"), body));
});
