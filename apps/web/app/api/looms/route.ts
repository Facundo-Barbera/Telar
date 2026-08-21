import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * THE WHOLE DECK IN ONE READ — projects, looms, triage, in-flight runs, and the
 * files the store could not read.
 *
 * ONE CALL RATHER THAN FIVE, and that is the engine's decision rather than this
 * adapter's convenience: fetched on separate cadences, the counts on a project
 * card would disagree with the loom list under it and nothing in either payload
 * would say which half was stale. The body is BARE for the same reason
 * `GET /api/spool` is — there is no second thing this route could return.
 */
export async function GET() {
  try {
    return Response.json(await (await engineClient()).looms());
  } catch (error) {
    return engineErrorResponse(error);
  }
}
