import { engineClient, engineErrorResponse, optionalString, requestObject, requiredString } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Dispatch one item by hand — the same verb a tick's decision reaches, taken
 * deliberately instead of derived. `title` and `brief` are optional and absent
 * means the engine reads them off the item, so they ride as spreads rather than
 * as explicit `undefined`, which `JSON.stringify` would erase anyway.
 */
export async function POST(request: Request) {
  try {
    const body = await requestObject(request);
    const title = optionalString(body.title, "title");
    const brief = optionalString(body.brief, "brief");
    return Response.json(
      await (await engineClient()).dispatchLoom(requiredString(body.projectId, "projectId"), {
        item: requiredString(body.item, "item"),
        ...(title === undefined ? {} : { title }),
        ...(brief === undefined ? {} : { brief }),
      }),
    );
  } catch (error) {
    return engineErrorResponse(error);
  }
}
