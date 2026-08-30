import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";
import { getLoom, loomState } from "@/lib/looms/store";
import { respawnLoomThreads } from "@/lib/looms/respawn";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ loomId: string }> };

/**
 * THE HUMAN'S RECOVERY POINT. Body `{ threads?: string[] }` — omit to
 * re-seed every non-green spawned thread. Same lib and same guard as the
 * conductor's `respawn` move; the only thing this route adds is a door
 * the human can open without asking an agent to propose it first.
 */
export async function POST(request: Request, context: Context) {
  try {
    const { loomId } = await context.params;
    const loom = getLoom(loomId);
    if (!loom) return Response.json({ error: { code: "not_found", message: `no loom ${loomId}` } }, { status: 404 });
    const state = loomState(loom);
    if (state === "accepted" || state === "waiting") {
      return Response.json(
        { error: { code: "conflict", message: `loom is ${state} — nothing to restart` } },
        { status: 409 },
      );
    }
    const body = (await request.json().catch(() => ({}))) as { threads?: string[] };
    const threads = Array.isArray(body.threads) && body.threads.length > 0 ? body.threads : undefined;
    const result = await respawnLoomThreads(loomId, await engineClient(), {
      ...(threads ? { threads } : {}),
      actor: "human",
    });
    return Response.json(result);
  } catch (error) {
    return engineErrorResponse(error);
  }
}
