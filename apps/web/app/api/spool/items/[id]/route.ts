import { engineClient, engineErrorResponse, requestObject } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

/** One item, plus the lane and rank the STACKS give it and its attachment tally.
 *  Both lane and rank absent means unfiled, which is a resting state. */
export async function GET(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    return Response.json(await (await engineClient()).spoolItem(id));
  } catch (error) {
    return engineErrorResponse(error);
  }
}

/**
 * Patch an item.
 *
 * FORWARDED WHOLE, deliberately. The engine refuses a forbidden key BY NAME —
 * `raw` and `rawSource` are the user's own words kept verbatim, `promotedFrom`
 * has no agent path, `tracking` and `timeline` have their own verbs — and it
 * throws a sentence saying which one and why. Filtering the body here would turn
 * "you cannot rewrite the user's own words" into a silent no-op, which is
 * indistinguishable from honouring it and is the exact failure that refusal
 * exists to prevent.
 *
 * Dismissing a desk card is `{ desk: false }` and it DRAINS THE ITEM TO THE
 * QUEUE — the item keeps its lane and its rank. There is no delete path here or
 * anywhere in this module.
 */
export async function PATCH(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const patch = await requestObject(request);
    return Response.json(await (await engineClient()).updateSpoolItem(id, patch));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
