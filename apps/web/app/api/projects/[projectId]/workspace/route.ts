import { requestObject, engineClient, engineErrorResponse } from "@/lib/engine/engine-server";
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

export async function GET(_request: Request, context: Context) {
  try {
    const { projectId } = await context.params;
    return Response.json(await (await engineClient()).projectWorkspace(projectId));
  } catch (error) {
    return engineErrorResponse(error);
  }
}

export async function PUT(request: Request, context: Context) {
  try {
    const { projectId } = await context.params;
    const body = await requestObject(request);
    return Response.json(
      await (await engineClient()).setProjectWorkspace(projectId, (body.overrides ?? {}) as ProjectWorkspaceOverrides),
    );
  } catch (error) {
    return engineErrorResponse(error);
  }
}
