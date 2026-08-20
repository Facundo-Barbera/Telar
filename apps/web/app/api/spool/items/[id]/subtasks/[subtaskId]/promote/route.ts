import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string; subtaskId: string }> };

/**
 * Take a sub-task out of its parent and stand it up as an item of its own.
 *
 * THE ONLY PROMOTION PATH IN THE CODEBASE, and it is reachable only from a human
 * click: no tool surface names it, proposed or otherwise. That is why the engine
 * may honestly stamp the new item's timeline entry `actor: "you"` with no
 * proposal marker — nothing else can reach this.
 *
 * It is also the only route that legitimately GROWS the queue's count, which is
 * consistent with the conservation law rather than an exception to it: the law
 * binds agents, and a human deciding a sub-task deserves to stand on its own is
 * reality growing.
 */
export async function POST(_request: Request, context: Context) {
  try {
    const { id, subtaskId } = await context.params;
    return Response.json(await (await engineClient()).promoteSpoolSubtask(id, subtaskId));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
