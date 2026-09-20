import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ sessionId: string }> };

/**
 * The cadence this conversation asked for, and how much mail is waiting on it.
 *
 * READ ONLY. Setting the window is a field of `PATCH /api/sessions/:id` — it
 * belongs to the session record, and a second write route for one field would
 * be a second place the bounds could disagree.
 */
export async function GET(_request: Request, context: Context) {
  try {
    const { sessionId } = await context.params;
    return Response.json(await (await engineClient()).sessionReportWindow(sessionId));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
