import { engineClient, engineErrorResponse, requestObject } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ subject: string }> };

/**
 * "Noted" — DRAINS one observation. The row is marked acknowledged and kept;
 * nothing here deletes, because the record of what the Spool told you is part
 * of the record.
 */
export async function POST(request: Request, context: Context) {
  try {
    const { subject } = await context.params;
    const body = await requestObject(request);
    if (typeof body.observationId !== "string" || !body.observationId) {
      return Response.json({ error: "observationId is required." }, { status: 400 });
    }
    return Response.json(await (await engineClient()).acknowledgeSpoolObservation(subject, body.observationId));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
