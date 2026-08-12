import { vnextEngine, vnextErrorResponse } from "@/lib/vnext/engine-server";

/**
 * A project's files, for the Files tree.
 *
 * `?path=` NARROWS TO ONE FILE'S TEXT — the same split as `/diff`, and for the
 * same reason: the tree asks for every path once, and a viewer asks for one file
 * at a time. The path is fenced inside the project root by the ENGINE, not here;
 * a check that only ran on this hop would not protect an in-process caller.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const { projectId } = await context.params;
    const target = new URL(request.url).searchParams.get("path");
    const engine = await vnextEngine();
    if (target) return Response.json(await engine.projectFile(projectId, target));
    return Response.json(await engine.projectFiles(projectId));
  } catch (error) {
    return vnextErrorResponse(error);
  }
}
