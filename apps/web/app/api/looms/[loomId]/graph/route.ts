import { engineErrorResponse } from "@/lib/engine/engine-server";
import { getLoom, readEvents } from "@/lib/looms/store";
import { deriveGraph } from "@/lib/looms/graph";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ loomId: string }> };

/** The loom's history as a causality DAG — see lib/looms/graph.ts. */
export async function GET(_request: Request, context: Context) {
  try {
    const { loomId } = await context.params;
    const loom = getLoom(loomId);
    if (!loom) return Response.json({ error: { code: "not_found", message: `no loom ${loomId}` } }, { status: 404 });
    return Response.json({ loomId, title: loom.title, ...deriveGraph(loom, readEvents(loomId)) });
  } catch (error) {
    return engineErrorResponse(error);
  }
}
