import { engineClient, engineErrorResponse, requestObject } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ subject: string }> };

/**
 * "Noted", in bulk — DRAINS every named observation in one gesture, which is
 * how a digest line's whole group goes quiet. Same law as the single ack:
 * rows are marked and kept, nothing deletes. Idempotent in the engine — an id
 * already drained, or one nothing goes by, changes nothing and fails nothing.
 */
export async function POST(request: Request, context: Context) {
  try {
    const { subject } = await context.params;
    const body = await requestObject(request);
    const ids = body.observationIds;
    if (!(Array.isArray(ids) && ids.length > 0 && ids.every((id) => typeof id === "string"))) {
      return Response.json({ error: "observationIds is a non-empty list of ids." }, { status: 400 });
    }
    return Response.json(await (await engineClient()).acknowledgeSpoolObservations(subject, ids as string[]));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
