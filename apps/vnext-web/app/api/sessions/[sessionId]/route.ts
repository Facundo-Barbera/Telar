import { vnextEngine, vnextErrorResponse } from "@/lib/vnext/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ sessionId: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const { sessionId } = await context.params;
    return Response.json(await (await vnextEngine()).session(sessionId));
  } catch (error) {
    return vnextErrorResponse(error);
  }
}

/** Rename, or change what the session may do without asking. The engine
 *  validates the patch; this route only forwards it. */
export async function PATCH(request: Request, context: Context) {
  try {
    const { sessionId } = await context.params;
    const patch = (await request.json()) as { title?: string; runtimeMode?: never; detached?: boolean };
    return Response.json(await (await vnextEngine()).updateSession(sessionId, patch));
  } catch (error) {
    return vnextErrorResponse(error);
  }
}
