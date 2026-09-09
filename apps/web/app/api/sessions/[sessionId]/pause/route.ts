import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ sessionId: string }> };

/**
 * PAUSE the session: stop the live turn and hold everything queued — and
 * everything that arrives — until a human resumes. A different route from
 * /stop, which ends one run and lets the worker take the next. The cockpit is
 * a human, so `by` is never forwarded from here.
 */
export async function POST(_request: Request, context: Context) {
  try {
    const { sessionId } = await context.params;
    return Response.json(await (await engineClient()).pauseSession(sessionId, "human"));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
