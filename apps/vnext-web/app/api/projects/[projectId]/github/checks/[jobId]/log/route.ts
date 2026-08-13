import { vnextEngine, vnextErrorResponse } from "@/lib/vnext/engine-server";

/**
 * One failing check's log.
 *
 * ASKED ON DEMAND, never with the pull request. A log is the heaviest thing on this
 * surface and the only one nobody wants until something is red, so it is fetched
 * when a reader opens a failing check — not for twenty-five green ones alongside it.
 *
 * NOT CACHED at any layer: a finished job's log is immutable, so there is nothing a
 * cache would save; a running job's log is the one thing that must not be stale.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string; jobId: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const { projectId, jobId } = await context.params;
    return Response.json(await (await vnextEngine()).projectCheckLog(projectId, jobId));
  } catch (error) {
    return vnextErrorResponse(error);
  }
}
