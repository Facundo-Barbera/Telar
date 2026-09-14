import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * ONE READ TO OPEN A CONVERSATION (#407).
 *
 * The cockpit used to ask this adapter twice on every switch — the snapshot,
 * then the journal from the cursor the snapshot stamped — and the two could not
 * overlap, because the second request's `after` is the first's answer. Each hop
 * is browser → this route → engine and back, so a switch paid that twice before
 * anything could be folded. The engine answers both at one instant; this route
 * only forwards it. See `SessionBootstrap`.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ sessionId: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const { sessionId } = await context.params;
    // The window rides through as given; the engine validates it.
    const params = new URL(request.url).searchParams;
    const turns = params.get("turns");
    const before = params.get("before");
    const window = turns === null ? undefined : { turns: Number(turns), ...(before === null ? {} : { before }) };
    return Response.json(await (await engineClient()).sessionBootstrap(sessionId, window));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
