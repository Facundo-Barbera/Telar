import { engineClient, engineRoute } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ serverId: string }> };

export const DELETE = engineRoute(async (_request: Request, context: Context) => {
  const { serverId } = await context.params;
  return Response.json(await (await engineClient()).removeMcpServer(serverId));
});
