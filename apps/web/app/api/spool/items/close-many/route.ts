import { engineClient, engineErrorResponse, requestObject } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Tick MANY checkboxes — the selection model's close. HUMAN API ONLY like the
 * single verb it is made of: the close verb does not exist on the agents'
 * tool wall at all, so a request that reaches this route can only be the
 * hand. Each id gets the same cascade and the same per-item shape as a single
 * close; an id nothing goes by comes back with `error` beside the ones that
 * landed, never as a thrown-away batch.
 */
export async function POST(request: Request) {
  try {
    const body = await requestObject(request);
    const ids = body.ids;
    if (!(Array.isArray(ids) && ids.length > 0 && ids.every((id) => typeof id === "string"))) {
      return Response.json({ error: "ids is a non-empty list of item ids." }, { status: 400 });
    }
    return Response.json(await (await engineClient()).closeSpoolItems(ids as string[]));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
