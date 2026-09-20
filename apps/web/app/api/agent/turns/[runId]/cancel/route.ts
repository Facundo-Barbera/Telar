import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * STOP THE AGENT'S LIVE TURN, or drop a queued one (#531).
 *
 * `stopped: false` IS A FACT, NOT A 404, and that is the whole reason this is
 * worth a note. A Stop pressed a beat after the turn finished is not a client
 * bug, and answering it with an error would paint a failure over a turn that
 * worked. The engine says whether there was anything left to stop; the screen
 * says nothing when there was not.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ runId: string }> };

export async function POST(_request: Request, context: Context) {
  try {
    const { runId } = await context.params;
    return Response.json(await (await engineClient()).cancelAgentTurn(runId));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
