import { engineClient, engineErrorResponse, requestObject, requiredString } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ key: string }> };

/**
 * Rename a lane — its LABEL, and nothing else.
 *
 * There is no route, here or anywhere, that changes a lane's `key`. That is what
 * closes the seed-lane hazard: the key an unplaceable capture falls back to can
 * never move under existing data, so renaming a label can never silently
 * redirect where new work lands.
 */
export async function PATCH(request: Request, context: Context) {
  try {
    const { key } = await context.params;
    const body = await requestObject(request);
    return Response.json(await (await engineClient()).renameSpoolLane(key, requiredString(body.label, "label")));
  } catch (error) {
    return engineErrorResponse(error);
  }
}

/**
 * Retire a lane.
 *
 * A REFUSAL IS A 200 RESULT, not an error, and this adapter forwards it as one.
 * Every refusal the engine produces names what the human must move first —
 * rendering it as a failed request would drop the sentence that made it
 * actionable. Retiring never evicts an item on the human's behalf.
 */
export async function DELETE(_request: Request, context: Context) {
  try {
    const { key } = await context.params;
    return Response.json(await (await engineClient()).retireSpoolLane(key));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
