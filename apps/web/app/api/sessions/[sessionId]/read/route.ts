import { engineClient, engineErrorResponse, requestObject, requiredString } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ sessionId: string }> };

/**
 * A HUMAN WAS SHOWN THIS TURN'S RESULT.
 *
 * The receipt names the turn that was on screen, never a time: a "read as of
 * now" would swallow whatever finished between the render being reported on
 * and this request landing, which is exactly the answer nobody has seen. The
 * engine keeps the highest result sequence anybody has confirmed, so a late or
 * duplicate receipt is a no-op — see `EngineStore.markSessionRead`, and
 * `components/session/read-receipt.tsx` for when the cockpit sends one.
 */
export async function POST(request: Request, context: Context) {
  try {
    const { sessionId } = await context.params;
    const input = await requestObject(request);
    return Response.json(await (await engineClient()).markSessionRead(sessionId, requiredString(input.runId, "run id")));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
