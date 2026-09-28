import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/** Scoped delete. Removing this project's `linear` must not take the global
 *  `linear` with it, which is exactly what an id-only match would do. */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string; serverId: string }> };

export async function DELETE(_request: Request, context: Context) {
  try {
    const { projectId, serverId } = await context.params;
    return Response.json(await (await engineClient()).removeMcpServer(serverId, projectId));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
