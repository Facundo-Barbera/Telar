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

/** Rename, change which model runs the next turn, or change what the session may
 *  do without asking. The engine validates the patch; this route only forwards
 *  it — including rejecting a model that does not belong to the session's own
 *  provider instance. */
export async function PATCH(request: Request, context: Context) {
  try {
    const { sessionId } = await context.params;
    const patch = (await request.json()) as Parameters<Awaited<ReturnType<typeof vnextEngine>>["updateSession"]>[1];
    return Response.json(await (await vnextEngine()).updateSession(sessionId, patch));
  } catch (error) {
    return vnextErrorResponse(error);
  }
}

/**
 * REMOVE A SESSION AND EVERYTHING IT OWNS. There is no undo.
 *
 * The engine holds the guards — a turn in flight refuses, the worktree and the
 * browser are freed, the directory goes — so this route forwards and nothing
 * else. The confirmation belongs in the UI, where the person is.
 */
export async function DELETE(_request: Request, context: Context) {
  try {
    const { sessionId } = await context.params;
    return Response.json(await (await vnextEngine()).deleteSession(sessionId));
  } catch (error) {
    return vnextErrorResponse(error);
  }
}
