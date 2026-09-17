import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * THE AGENT'S TRANSCRIPT, from either end (#531, #580).
 *
 * BOUNDED LIKE EVERY OTHER READ HERE (#515): the engine caps by a count AND a
 * byte budget, whichever is reached first, and answers `more` when it stopped
 * early. A screen pages until `more` is false rather than asking for everything
 * — a thread that has run for a week is not a thing to put in one response.
 *
 * `after` PAGES FORWARD, which is what a poll rides. `tail=1` opens on the LAST
 * page and `before=<id>` walks back from it, so a screen opening a long
 * conversation draws the end of it immediately instead of reading the whole
 * thing oldest-first to reach it.
 *
 * EVERY PARAMETER IS PASSED THROUGH AS TYPED, not re-validated: the engine
 * clamps them and refuses what it cannot read, and a second set of bounds here
 * would be a second thing to keep in step with the one that actually pages.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const after = url.searchParams.get("after");
    const before = url.searchParams.get("before");
    const tail = url.searchParams.get("tail");
    const limit = url.searchParams.get("limit");
    return Response.json(
      await (await engineClient()).agentThread({
        ...(after === null ? {} : { after: Number(after) }),
        ...(before === null ? {} : { before: Number(before) }),
        ...(tail === "1" || tail === "true" ? { tail: true } : {}),
        ...(limit === null ? {} : { limit: Number(limit) }),
      }),
    );
  } catch (error) {
    return engineErrorResponse(error);
  }
}
