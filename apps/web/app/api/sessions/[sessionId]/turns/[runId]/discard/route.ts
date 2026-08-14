import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ sessionId: string; runId: string }> };

/** Thin authenticated-adapter proxy; the engine validates ambiguous-only state. */
export async function POST(_request: Request, context: Context) {
  try {
    const { sessionId, runId } = await context.params;
    return Response.json(await (await engineClient()).discardAmbiguousTurn(sessionId, runId));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
