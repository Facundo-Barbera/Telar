import { engineClient, engineErrorResponse, requestObject } from "@/lib/engine/engine-server";

/**
 * What one login's reader did to that provider's model list.
 *
 * FOUR LISTS, PATCHED BY PRESENCE. Each key is forwarded only when the client
 * actually sent it, because `[]` ("I cleared this") and absent ("I did not touch
 * it") are different requests and JSON can only tell them apart by the key. The
 * engine owns every other rule — what a model id may look like, how long a list
 * may be, whether two custom rows may share an id.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ instanceId: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const { instanceId } = await context.params;
    return Response.json(await (await engineClient()).modelOverlay(instanceId));
  } catch (error) {
    return engineErrorResponse(error);
  }
}

export async function PATCH(request: Request, context: Context) {
  try {
    const { instanceId } = await context.params;
    const input = await requestObject(request);
    return Response.json(
      await (await engineClient()).setModelOverlay(instanceId, {
        ...("favorites" in input ? { favorites: input.favorites as string[] } : {}),
        ...("hidden" in input ? { hidden: input.hidden as string[] } : {}),
        ...("order" in input ? { order: input.order as string[] } : {}),
        ...("custom" in input ? { custom: input.custom as { id: string; label?: string }[] } : {}),
      }),
    );
  } catch (error) {
    return engineErrorResponse(error);
  }
}
