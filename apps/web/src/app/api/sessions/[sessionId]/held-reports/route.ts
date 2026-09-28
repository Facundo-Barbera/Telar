import { engineClient, engineRoute } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ sessionId: string }> };

export const GET = engineRoute(async (_request: Request, context: Context) => {
  const { sessionId } = await context.params;
  return Response.json(await (await engineClient()).sessionHeldReports(sessionId));
});
