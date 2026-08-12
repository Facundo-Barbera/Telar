import { vnextEngine, vnextErrorResponse } from "@/lib/vnext/engine-server";

/**
 * The session's own checkout, as a file list — its worktree when it cut one, so
 * the tree describes the directory the agent is actually writing in rather than
 * whatever the project root happens to hold.
 *
 * `?path=` narrows to one file's text. Fenced by the engine; see the project
 * route beside this one.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ sessionId: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const { sessionId } = await context.params;
    const target = new URL(request.url).searchParams.get("path");
    const engine = await vnextEngine();
    if (target) return Response.json(await engine.sessionFile(sessionId, target));
    return Response.json(await engine.sessionFiles(sessionId));
  } catch (error) {
    return vnextErrorResponse(error);
  }
}
