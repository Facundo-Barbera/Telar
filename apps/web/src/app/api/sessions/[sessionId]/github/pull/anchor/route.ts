import { engineClient, engineRoute } from "@/platform/engine/server";

/**
 * What placing a Diff line on this session branch's pull request needs — #1014.
 * The branch comes off the session record in the engine, so nothing is read here.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ sessionId: string }> };

export const GET = engineRoute(async (_request: Request, context: Context) => {
  const { sessionId } = await context.params;
  return Response.json(await (await engineClient()).sessionPullAnchor(sessionId));
});
