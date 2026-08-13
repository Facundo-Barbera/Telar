import { vnextEngine, vnextErrorResponse } from "@/lib/vnext/engine-server";

/**
 * What there is to filter by in a project's repository.
 *
 * A SEPARATE ROUTE because it has a separate lifetime: milestones, labels and who
 * can be assigned change on the timescale of a sprint, so the engine holds them for
 * five minutes rather than the thirty seconds a list read gets. Nothing calls this
 * until a reader opens a filter menu, which means the whole feature costs nothing to
 * anybody who never filters.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const { projectId } = await context.params;
    const refresh = new URL(request.url).searchParams.get("refresh") === "1";
    return Response.json(await (await vnextEngine()).projectForgeFacets(projectId, { refresh }));
  } catch (error) {
    return vnextErrorResponse(error);
  }
}
