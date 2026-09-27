import { EngineClientError } from "@telar/engine-client";
import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ sessionId: string; taskId: string }> };

/** A page of a background task's log — the Processes tab's row. `after` is a
 *  byte cursor; absent asks for the tail. */
export async function GET(request: Request, context: Context) {
  try {
    const { sessionId, taskId } = await context.params;
    const raw = new URL(request.url).searchParams.get("after");
    const after = raw === null ? undefined : Number(raw);
    if (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) throw new EngineClientError("invalid_request", "after must be a byte offset");
    return Response.json(await (await engineClient()).taskOutput(sessionId, taskId, after));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
