import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * Every checkout this install is keeping, classified — issue #671.
 *
 * A VERDICT PER ROW, NOT FOUR COLUMNS. The engine proves merged, clean, and
 * whether anything still needs it, so the surface does not ask a person to
 * check three things by hand before daring to delete — which is the behaviour
 * that let 7.3 GB accumulate behind finished sessions with only a count to
 * show for it.
 *
 * NOT CACHED, DELIBERATELY, unlike the storage report this sits beneath. Every
 * rung of the classification is live — a session starts working, a drive is
 * unplugged, a PR merges — and a cached verdict is one that was true earlier
 * and is about to be acted on.
 *
 * COSTS A WALK PER CHECKOUT, so nothing may poll it.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    return Response.json(await (await engineClient()).worktrees({ signal: request.signal }));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
