import { engineClient, requestObject, engineRoute } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * TOP-LEVEL, because a subscription spans two sessions and is owned by neither
 * — the same reason the engine's own route is not session-scoped.
 */
export const DELETE = engineRoute(async (request: Request, { params }: { params: Promise<{ subscriptionId: string }> }) => {
  const { subscriptionId } = await params;
  const input = await requestObject(request).catch(() => ({}) as Record<string, unknown>);
  return Response.json(
    await (await engineClient()).unsubscribe(subscriptionId, {
      ...(typeof input.subscriberSessionId === "string" ? { subscriberSessionId: input.subscriberSessionId } : {}),
    }),
  );
});
