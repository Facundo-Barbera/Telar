import { engineClient, engineErrorResponse, requestObject } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

/**
 * Retire a note — DRAINS it off the working shelf, deletes nothing. The
 * reason is required here as it is in the engine and the store: withdrawing
 * knowledge silently is how a shelf stops being trustworthy, so the rule is
 * the record's meaning, not an input-validation nicety.
 */
export async function POST(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const body = await requestObject(request);
    if (typeof body.reason !== "string" || body.reason.trim() === "") {
      return Response.json(
        { error: "reason is required — retiring records why the knowledge stopped mattering, not that it is gone." },
        { status: 400 },
      );
    }
    return Response.json(await (await engineClient()).retireSpoolNote(id, body.reason));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
