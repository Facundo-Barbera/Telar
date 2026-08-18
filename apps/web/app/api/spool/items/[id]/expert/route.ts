import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

/**
 * Ask this item's project expert to read it — the interpreter, on demand.
 *
 * IT NO LONGER WAITS, and this route no longer needs `maxDuration = 300`. It
 * had one, with a note saying that if a pass ever outlived it the fix would be
 * "the job record the daemon's own note describes, not a bigger number here."
 * That record is `spool/work.ts`, so: this starts the pass and answers at once
 * with it. Progress comes from `/api/spool/work`.
 *
 * A REFUSAL COMES BACK AS 200 WITH ITS SENTENCE. "This item is floating, so it
 * has no expert" is the ANSWER to the question the button asked, not a
 * malformed request, and the sentence names what to do next. Forwarding it as a
 * 4xx would invite the caller to render a generic error and drop the only
 * useful part — the same reasoning the lane-retire route already carries.
 *
 * TWO CLICKS ARE ONE PASS, and it is the ENGINE that guarantees it now. This
 * used to say "the surface's busy state is what prevents the second", which was
 * true only until a reload — the guard now sits in the process that would spend
 * the money, and a second click comes back with the record of the first.
 */
export async function POST(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    return Response.json(await (await engineClient()).startSpoolExpert(id));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
