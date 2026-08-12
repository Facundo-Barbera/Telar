import {
  requestObject,
  requiredString,
  vnextEngine,
  vnextErrorResponse,
} from "@/lib/vnext/engine-server";

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
export async function POST(request: Request, context: Context) {
  try {
    const [{ sessionId, requestId }, body] = await Promise.all([context.params, requestObject(request)]);
    const answers = body.answers && typeof body.answers === "object" ? (body.answers as Record<string, unknown>) : undefined;
    return Response.json(
      await (await vnextEngine()).resolveRequest(sessionId, requestId, {
        decision: requiredString(body.decision, "Decision") as "accept" | "acceptForSession" | "decline" | "cancel",
        ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
        ...(answers ? { answers } : {}),
      }),
    );
  } catch (error) {
    return vnextErrorResponse(error);
  }
}
