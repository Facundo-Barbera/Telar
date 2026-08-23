import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";
import { CONDUCT_COOLDOWN_MS, conductEpisode } from "@/lib/looms/conductor";
import { getLoom } from "@/lib/looms/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

type Context = { params: Promise<{ loomId: string }> };

/** Wake one conductor episode. Throttled: the room's poll may call this
 *  freely and the cooldown decides whether an episode actually runs. */
export async function POST(_request: Request, context: Context) {
  try {
    const { loomId } = await context.params;
    const loom = getLoom(loomId);
    if (!loom) return Response.json({ error: { code: "not_found", message: `no loom ${loomId}` } }, { status: 404 });
    if (loom.conductedAt && Date.now() - loom.conductedAt < CONDUCT_COOLDOWN_MS) {
      return Response.json({ skipped: "cooldown" }, { status: 202 });
    }
    const result = await conductEpisode(loomId, await engineClient());
    return Response.json(result);
  } catch (error) {
    return engineErrorResponse(error);
  }
}
