import { EngineClientError } from "@telar/engine-client";
import { vnextEngine, vnextErrorResponse } from "@/lib/vnext/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ sessionId: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const after = Number(new URL(request.url).searchParams.get("after") ?? "0");
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new EngineClientError("invalid_request", "Event cursor must be a non-negative integer.");
    }
    const { sessionId } = await context.params;
    return Response.json(await (await vnextEngine()).events(sessionId, after));
  } catch (error) {
    return vnextErrorResponse(error);
  }
}
