import { engineClient, engineRoute } from "@/platform/engine/server";

/** Scoped delete. Removing this project's `linear` must not take the global
 *  `linear` with it, which is exactly what an id-only match would do. */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string; serverId: string }> };

export const DELETE = engineRoute(async (_request: Request, context: Context) => {
  const { projectId, serverId } = await context.params;
  return Response.json(await (await engineClient()).removeMcpServer(serverId, projectId));
});
