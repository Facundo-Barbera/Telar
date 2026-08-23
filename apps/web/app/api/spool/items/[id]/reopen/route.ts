import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

/**
 * Untick it — equally the hand's, equally instant (`docs/spool-loops.md` §9).
 *
 * Removes `closed` and NOTHING else: threads the close cascade settled stay
 * settled — their answer ("the user closed the task") is a true record of a
 * moment that happened, and reopening the item does not unmake it. Open a
 * new question instead. The close/reopen pair stays on the item's timeline,
 * so the record reads "closed by hand … reopened by hand" rather than being
 * scrubbed. Idempotent like its twin.
 */
export async function POST(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    return Response.json(await (await engineClient()).reopenSpoolItem(id));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
