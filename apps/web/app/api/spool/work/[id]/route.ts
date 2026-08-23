import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

/**
 * Stop one pass.
 *
 * `{stopped: false}` COMES BACK AS 200. "There is nothing running under that
 * id" is the honest answer to a surface whose record is a poll or two old, and
 * it is the state the caller was asking for anyway. A 404 would invite the UI
 * to draw an error for a button that did its job.
 *
 * WHAT IT DOES NOT DO IS SETTLE THE ENTRY. The pass settles itself when the SDK
 * unwinds, carrying `structuredAgent`'s own "the call was cancelled; nothing
 * was written" — settling here would race that and could report a cancellation
 * for a call that had already emitted its result.
 */
export async function DELETE(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    return Response.json(await (await engineClient()).cancelSpoolWork(id));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
