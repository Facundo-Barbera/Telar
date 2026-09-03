import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ sessionId: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const { sessionId } = await context.params;
    // The window rides through as given; the engine validates it.
    const params = new URL(request.url).searchParams;
    const turns = params.get("turns");
    const before = params.get("before");
    const window = turns === null ? undefined : { turns: Number(turns), ...(before === null ? {} : { before }) };
    return Response.json(await (await engineClient()).session(sessionId, window));
  } catch (error) {
    return engineErrorResponse(error);
  }
}

/** Rename, change which model runs the next turn, or change what the session may
 *  do without asking. The engine validates the patch; this route only forwards
 *  it — including rejecting a model that does not belong to the session's own
 *  provider instance. */
export async function PATCH(request: Request, context: Context) {
  try {
    const { sessionId } = await context.params;
    const patch = (await request.json()) as Parameters<Awaited<ReturnType<typeof engineClient>>["updateSession"]>[1];
    return Response.json(await (await engineClient()).updateSession(sessionId, patch));
  } catch (error) {
    return engineErrorResponse(error);
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
    return Response.json(await (await engineClient()).deleteSession(sessionId));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
