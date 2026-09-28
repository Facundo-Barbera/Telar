import { EngineClientError } from "@telar/engine-client";
import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ sessionId: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const params = new URL(request.url).searchParams;
    const after = Number(params.get("after") ?? "0");
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new EngineClientError("invalid_request", "Event cursor must be a non-negative integer.");
    }
    /**
     * `limit` IS RELAYED, NOT RE-DECIDED (#494). The engine owns the default
     * and the cap; a second opinion here would only be a way for the two to
     * disagree about how big a page is. Absent stays absent, so the engine's
     * default is what an unadorned caller gets.
     */
    const raw = params.get("limit");
    if (raw !== null && (!Number.isSafeInteger(Number(raw)) || Number(raw) < 1)) {
      throw new EngineClientError("invalid_request", "Event limit must be a positive integer.");
    }
    const { sessionId } = await context.params;
    return Response.json(await (await engineClient()).events(sessionId, after, raw === null ? undefined : Number(raw)));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
