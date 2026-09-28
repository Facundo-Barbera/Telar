import { parseFilePatchQuery } from "@telar/engine-client";

import { engineClient, engineRoute } from "@/platform/engine/server";

/**
 * A project's uncommitted work.
 *
 * The same surface as a session's review, asked of a project instead — which is
 * what the new-conversation canvas has before its session exists. `?path=`
 * narrows to one file's patch, for the same size reason.
 *
 * PARSED BY THE CONTRACT'S PARSER, like its session twin — they serve one
 * surface, so an option one forwarded and the other dropped would be a control
 * that worked in a conversation and did nothing on a canvas. That is not
 * hypothetical: it is what #694 shipped.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string }> };

export const GET = engineRoute(async (request: Request, context: Context) => {
  const { projectId } = await context.params;
  const url = new URL(request.url);
  const engine = await engineClient();
  const target = url.searchParams.get("path");
  if (target) {
    return Response.json(await engine.projectFilePatch(projectId, target, parseFilePatchQuery(url.searchParams)));
  }
  return Response.json(await engine.projectDiff(projectId));
});
