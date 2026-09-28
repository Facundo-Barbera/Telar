import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ sessionId: string }> };

/**
 * Close every terminal this session holds, as the person — a settled row's
 * way to end what it still runs (#883). The same host close a settle makes.
 */
export async function POST(_request: Request, context: Context) {
  try {
    const { sessionId } = await context.params;
    return Response.json(await (await engineClient()).closeSessionTerminals(sessionId));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
