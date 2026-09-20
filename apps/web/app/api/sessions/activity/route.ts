import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * WHEN EACH PROJECT WAS LAST WORKED IN — the front door's read (#490).
 *
 * The launch path used to ask `/api/sessions/live?all=1` for this: 101.6 KB and
 * 291 sessions on the owner's store, folded in the browser into one integer per
 * project and otherwise thrown away. This is that fold, answered off the
 * engine's session index without opening a conversation.
 *
 * FORWARDED VERBATIM, unlike `/live` beside it. That route RE-COMPOSES the
 * engine's answer because it stitches the project registry into it; this answer
 * is two scalars per row and has nothing to stitch, so there is no field here
 * that can be silently dropped on the way through.
 */
export async function GET() {
  try {
    return Response.json(await (await engineClient()).projectActivity());
  } catch (error) {
    return engineErrorResponse(error);
  }
}
