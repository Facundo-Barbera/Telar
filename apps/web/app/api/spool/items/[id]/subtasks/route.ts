import { engineClient, engineErrorResponse, requestObject, requiredString } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

/**
 * Break an item down — INSIDE the item.
 *
 * This is the conservation valve: work discovered mid-item becomes a sub-task on
 * the parent rather than a new queue entry, so the queue's count grows only when
 * reality grows. Adding one touches no lane and changes no row count, and the
 * queue footer's numbers are what say so out loud.
 */
export async function POST(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const body = await requestObject(request);
    return Response.json(await (await engineClient()).addSpoolSubtask(id, requiredString(body.title, "title")));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
