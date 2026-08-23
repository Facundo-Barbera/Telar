import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";
import { appendJournal, getLoom, saveLoom } from "@/lib/looms/store";
import { spawnThreads } from "@/lib/looms/spawn";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ loomId: string }> };

/**
 * CLEARING THE EXECUTE GATE — the human act that turns thread plans into
 * sessions. UI-only by the same reasoning as accept: gates exist so a human
 * decides what runs; an agent-callable approve would be standing orders
 * without the policy. (Standing orders, when they land, go through their own
 * declared policy — never through this route.)
 */
export async function POST(_request: Request, context: Context) {
  try {
    const { loomId } = await context.params;
    const loom = getLoom(loomId);
    if (!loom) return Response.json({ error: { code: "not_found", message: `no loom ${loomId}` } }, { status: 404 });
    const execute = loom.phases?.find((p) => p.kind === "execute");
    if (!execute || execute.status !== "waiting") {
      return Response.json({ error: { code: "conflict", message: "this loom has no open execute gate" } }, { status: 409 });
    }
    execute.status = "running";
    execute.at = Date.now();
    saveLoom(loom);
    appendJournal(loomId, "human", "cleared the execute gate — spawning threads");
    const spawned = await spawnThreads(getLoom(loomId)!, await engineClient());
    return Response.json(spawned);
  } catch (error) {
    return engineErrorResponse(error);
  }
}
