import { requestObject, engineClient, engineRoute } from "@/platform/engine/server";
import type { ProjectWorkspaceOverrides } from "@telar/engine-client";

/**
 * ONE PROJECT'S worktree preparation: its overrides, and the engine's own
 * resolution of them against this Mac and the repo's `.telar/workspace.json`.
 *
 * A WHOLE-OVERRIDES PUT, forwarded unvalidated — the engine owns the schema.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string }> };

export const GET = engineRoute(async (_request: Request, context: Context) => {
  const { projectId } = await context.params;
  return Response.json(await (await engineClient()).projectWorkspace(projectId));
});

export const PUT = engineRoute(async (request: Request, context: Context) => {
  const { projectId } = await context.params;
  const body = await requestObject(request);
  return Response.json(
    await (await engineClient()).setProjectWorkspace(projectId, (body.overrides ?? {}) as ProjectWorkspaceOverrides),
  );
});
