import { engineClient, engineRoute } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ sessionId: string; runId: string }> };

/** Thin authenticated-adapter proxy; the engine validates ambiguous-only state. */
export const POST = engineRoute(async (_request: Request, context: Context) => {
  const { sessionId, runId } = await context.params;
  return Response.json(await (await engineClient()).discardAmbiguousTurn(sessionId, runId));
});
