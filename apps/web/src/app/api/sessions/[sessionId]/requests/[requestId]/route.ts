import { requestObject, requiredString, engineClient, engineRoute } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ sessionId: string; requestId: string }> };

/**
 * A human answering a parked approval.
 *
 * Thin proxy: the ENGINE owns the decision vocabulary and the already-resolved
 * conflict, because a worker blocked inside canUseTool is waiting on its
 * answer and two parties deciding what "accept" means is how that deadlocks.
 */
export const POST = engineRoute(async (request: Request, context: Context) => {
  const [{ sessionId, requestId }, body] = await Promise.all([context.params, requestObject(request)]);
  const answers = body.answers && typeof body.answers === "object" ? (body.answers as Record<string, unknown>) : undefined;
  return Response.json(
    await (await engineClient()).resolveRequest(sessionId, requestId, {
      decision: requiredString(body.decision, "Decision") as "accept" | "acceptForSession" | "decline" | "cancel",
      ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
      ...(answers ? { answers } : {}),
    }),
  );
});
