import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * MUCH LONGER THAN EVERY OTHER ROUTE UNDER `/api/spool`. This one awaits a model
 * turn — seconds to minutes — where its neighbours are a disk read. The default
 * function timeout is what governs it, and if a pass ever outlives that the fix
 * is the job record the daemon's own note describes, not a bigger number here.
 */
export const maxDuration = 300;

type Context = { params: Promise<{ id: string }> };

/**
 * Ask this item's project expert to read it — the interpreter, on demand.
 *
 * A REFUSAL COMES BACK AS 200 WITH ITS SENTENCE. "This item is floating, so it
 * has no expert" is the ANSWER to the question the button asked, not a
 * malformed request, and the sentence names what to do next. Forwarding it as a
 * 4xx would invite the caller to render a generic error and drop the only
 * useful part — the same reasoning the lane-retire route already carries.
 *
 * NOTHING HERE IS IDEMPOTENT. A pass appends its timeline events and mined
 * commitments by design, because the packet is the audit trail. Two clicks are
 * two passes; the surface's busy state is what prevents the second.
 */
export async function POST(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    return Response.json(await (await engineClient()).consultSpoolExpert(id));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
