import { vnextEngine, vnextErrorResponse } from "@/lib/vnext/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ sessionId: string }> };

/**
 * End a session and free its worktree.
 *
 * The BRANCH survives — it is the session's output, and destroying it is a
 * separate human decision the engine deliberately does not fold into this one.
 * This is what the rail's one-click settle actually does; there is no softer
 * "settled but still live" state in the vNext model to reach for.
 */
export async function POST(_request: Request, context: Context) {
  try {
    const { sessionId } = await context.params;
    return Response.json(await (await vnextEngine()).archiveSession(sessionId));
  } catch (error) {
    return vnextErrorResponse(error);
  }
}
