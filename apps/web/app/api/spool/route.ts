import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Everything the queue renders, in one read.
 *
 * ONE CALL RATHER THAN FOUR, and that is the engine's decision rather than this
 * adapter's convenience: `rows` is a join over the lanes and the items, and
 * `unreadable` is the diagnostic channel for the faults that join DROPS. Fetched
 * separately, a client could render a queue whose rows disagree with its lane
 * list — or, worse, a shrunken one with no sign that anything was wrong.
 */
export async function GET() {
  try {
    return Response.json(await (await engineClient()).spool());
  } catch (error) {
    return engineErrorResponse(error);
  }
}
