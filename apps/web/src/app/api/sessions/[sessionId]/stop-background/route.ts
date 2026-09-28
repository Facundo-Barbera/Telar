import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ sessionId: string }> };

/**
 * Stop the session's lingering background tasks — the "N tasks still working"
 * chip. A DIFFERENT route from /stop: background work outlives its turn, so
 * there may be no turn to stop, and stopping the turn deliberately spares it.
 */
export async function POST(_request: Request, context: Context) {
  try {
    const { sessionId } = await context.params;
    return Response.json(await (await engineClient()).stopBackgroundTasks(sessionId));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
