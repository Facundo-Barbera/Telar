import { engineClient, engineErrorResponse, requestObject } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string; subtaskId: string }> };

/**
 * Tick a sub-task, or untick it.
 *
 * `done` HERE IS NOT A STATUS ON THE ITEM. There is no status, state, done or
 * accepted field on an item at all — the absence IS the human-accept moat — and
 * this flag lives on the sub-task, where it renders as the parent row's
 * `done/total` and nothing more. Nothing about it advances any work.
 */
export async function PATCH(request: Request, context: Context) {
  try {
    const { id, subtaskId } = await context.params;
    const body = await requestObject(request);
    return Response.json(await (await engineClient()).setSpoolSubtaskDone(id, subtaskId, body.done === true));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
