import { vnextEngine, vnextErrorResponse } from "@/lib/vnext/engine-server";

/**
 * A project's uncommitted work.
 *
 * The same surface as a session's review, asked of a project instead — which is
 * what the new-conversation canvas has before its session exists. `?path=`
 * narrows to one file's patch, for the same size reason.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const { projectId } = await context.params;
    const url = new URL(request.url);
    const engine = await vnextEngine();
    const target = url.searchParams.get("path");
    if (target) {
      return Response.json(await engine.projectFilePatch(projectId, target, { untracked: url.searchParams.get("untracked") === "1" }));
    }
    return Response.json(await engine.projectDiff(projectId));
  } catch (error) {
    return vnextErrorResponse(error);
  }
}
