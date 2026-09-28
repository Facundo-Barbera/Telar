import { engineClient, requestObject, engineRoute } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * WHO THIS SESSION IS FOLLOWING — a one-directional, revocable wish to be woken
 * when another session does something. Stored engine-wide because the pair spans
 * two sessions and belongs to neither.
 *
 * FOLLOWING IS NOT A RELATIONSHIP OF AUTHORITY. It changes what wakes you and
 * nothing else: no permission travels along it, and unsubscribing stops no work.
 */
export const GET = engineRoute(async (_request: Request, { params }: { params: Promise<{ sessionId: string }> }) => {
  const { sessionId } = await params;
  return Response.json(await (await engineClient()).subscriptions(sessionId));
});

export const POST = engineRoute(async (request: Request, { params }: { params: Promise<{ sessionId: string }> }) => {
  const { sessionId } = await params;
  const input = await requestObject(request);
  return Response.json(
    await (await engineClient()).subscribe(sessionId, {
      targetSessionId: String(input.targetSessionId ?? ""),
      ...(Array.isArray(input.events) ? { events: input.events as never } : {}),
      ...(input.once === true ? { once: true } : {}),
    }),
  );
});
