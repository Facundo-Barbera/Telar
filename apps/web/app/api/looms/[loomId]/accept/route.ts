import { engineErrorResponse } from "@/lib/engine/engine-server";
import { getLoom, loomState, saveLoom } from "@/lib/looms/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ loomId: string }> };

/**
 * THE MOAT. Accept is a human click on the /looms page and nothing else —
 * there is no MCP tool, no engine call, and no agent code path that reaches
 * this route. It also refuses unless the loom is `ready`: a human can only
 * accept work whose every thread has a green verification.
 */
export async function POST(_request: Request, context: Context) {
  try {
    const { loomId } = await context.params;
    const loom = getLoom(loomId);
    if (!loom) return Response.json({ error: { code: "not_found", message: `no loom ${loomId}` } }, { status: 404 });
    const state = loomState(loom);
    if (state !== "ready") {
      return Response.json(
        { error: { code: "not_ready", message: `a loom is accepted only from ready — this one is ${state}` } },
        { status: 409 },
      );
    }
    loom.acceptedAt = Date.now();
    return Response.json(saveLoom(loom));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
