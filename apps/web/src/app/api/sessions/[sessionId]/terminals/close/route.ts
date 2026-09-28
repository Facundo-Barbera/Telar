import { engineClient, engineRoute } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ sessionId: string }> };

/**
 * Close every terminal this session holds, as the person — a settled row's
 * way to end what it still runs (#883). The same host close a settle makes.
 */
export const POST = engineRoute(async (_request: Request, context: Context) => {
  const { sessionId } = await context.params;
  return Response.json(await (await engineClient()).closeSessionTerminals(sessionId));
});
