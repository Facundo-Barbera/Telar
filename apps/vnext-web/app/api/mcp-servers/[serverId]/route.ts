import { vnextEngine, vnextErrorResponse } from "@/lib/vnext/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ serverId: string }> };

export async function DELETE(_request: Request, context: Context) {
  try {
    const { serverId } = await context.params;
    return Response.json(await (await vnextEngine()).removeMcpServer(serverId));
  } catch (error) {
    return vnextErrorResponse(error);
  }
}
