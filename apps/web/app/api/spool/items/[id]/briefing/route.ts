import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

/**
 * BRIEFED ARRIVAL — the composed opening context for "work on this".
 *
 * A READ, not a verb: the engine composes the packet, the raw words, the
 * thread state and the delta from the subject's stored look into one
 * deterministic text — no model call, no session created, no turn queued.
 * The web writes it into the composer as a DRAFT and the human sends it, so
 * nothing is spent until they do. `briefing.project` absent means no
 * registered project matches the item's subject — an ordinary answer the
 * caller renders, never a failure.
 */
export async function GET(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    return Response.json(await (await engineClient()).spoolBriefing(id));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
