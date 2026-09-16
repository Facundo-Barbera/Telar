import { requestObject, engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * ANSWER THE APPROVAL THE AGENT IS PARKED ON (#531).
 *
 * BY ID, so a client holding a stale question cannot approve the one that
 * replaced it — `resolved: false` means it had already been answered, which is
 * what two open cockpits racing on the same approval looks like and is not an
 * error in either of them.
 *
 * TWO DECISIONS, NOT THREE. A session's approval takes Allow once / Always
 * allow / Deny, but `acceptForSession` is exactly what its name says and there
 * is no session here to scope it to: the Agent's gate is argument-aware and
 * decided per call (`agent/approval.ts`). Offering an "always" that nothing
 * could honour would be a button that lies about how much rope was handed over.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ requestId: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const { requestId } = await context.params;
    const body = await requestObject(request);
    const decision = body.decision === "accept" ? "accept" : body.decision === "decline" ? "decline" : undefined;
    if (!decision) {
      return Response.json({ error: { code: "invalid_request", message: 'decision must be "accept" or "decline"' } }, { status: 400 });
    }
    return Response.json(await (await engineClient()).resolveAgentRequest(requestId, decision));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
