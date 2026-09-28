import { engineClient, engineRoute } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ sessionId: string }> };

/**
 * How many terminals this session holds open, whoever opened them — what
 * Settle would close (#883). Asked as the conversation's menu opens, never on
 * a timer; the rail gets the same count on its live read.
 */
export const GET = engineRoute(async (_request: Request, context: Context) => {
  const { sessionId } = await context.params;
  return Response.json(await (await engineClient()).sessionTerminals(sessionId));
});
