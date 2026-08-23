import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

/**
 * Tick the checkbox — the human's own close (`docs/spool-loops.md` §9).
 *
 * A DEDICATED VERB, NEVER THE GENERIC PATCH: `closed` is refused by name on
 * the item PATCH, and the close verb does not exist on the agents' tool wall
 * at all — so a request that reaches this route can only be the hand. The
 * engine cascades: every open thread holding this capture settles with the
 * honest answer "the user closed the task", and a thread that refused comes
 * back in `refused` with its sentence rather than undoing the close.
 *
 * IDEMPOTENT — closing a closed item answers with its note and changes
 * nothing, which is what lets the checkbox be a checkbox: no confirmation
 * dialog guards it anywhere, because nothing here needs guarding.
 */
export async function POST(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    return Response.json(await (await engineClient()).closeSpoolItem(id));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
