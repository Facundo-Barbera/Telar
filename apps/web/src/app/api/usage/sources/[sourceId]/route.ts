import { requestObject, engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * One hub: saved, or forgotten.
 *
 * THE BODY RIDES THROUGH VERBATIM. The engine owns every rule about it — the
 * URL must parse and be http(s), an empty management key KEEPS the stored one,
 * a `null` label clears it — and re-checking any of that here would be a second
 * copy that could disagree with the first.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ sourceId: string }> };

export async function PUT(request: Request, context: Context) {
  try {
    const { sourceId } = await context.params;
    const body = await requestObject(request);
    return Response.json(
      await (await engineClient()).saveUsageLimitSource({
        id: sourceId,
        ...(body.label === undefined ? {} : { label: body.label as string | null }),
        ...(body.url === undefined ? {} : { url: body.url as string }),
        ...(body.managementKey === undefined ? {} : { managementKey: body.managementKey as string }),
        ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
      }),
    );
  } catch (error) {
    return engineErrorResponse(error);
  }
}

export async function DELETE(_request: Request, context: Context) {
  try {
    const { sourceId } = await context.params;
    return Response.json(await (await engineClient()).removeUsageLimitSource(sourceId));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
