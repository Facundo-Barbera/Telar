import { engineClient, engineErrorResponse, requestObject } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ key: string }> };

/**
 * "This lane's stack becomes exactly these ids, in this order."
 *
 * ONE VERB FOR BOTH GESTURES — an in-lane reorder and a cross-lane drag — because
 * the engine adopts any id it finds in another lane's stack rather than refusing
 * a permutation that does not match the stored one. That is also what lets a lane
 * holding an adopted orphan be reordered as the human SEES it rendered.
 *
 * Order is stack position. Nothing here is a schedule.
 */
export async function POST(request: Request, context: Context) {
  try {
    const { key } = await context.params;
    const body = await requestObject(request);
    const items = body.items;
    if (!Array.isArray(items) || items.some((id) => typeof id !== "string")) {
      return Response.json(
        { error: { code: "invalid_request", message: "a reorder is a list of item ids" } },
        { status: 400 },
      );
    }
    return Response.json(await (await engineClient()).reorderSpoolLane(key, items as string[]));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
