import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ subject: string }> };

/** One subject's STORED look — no network, `fresh: false`, and a `note` for a
 *  subject with no terrain. Reconciling is a different verb: POST /api/spool/look. */
export async function GET(_request: Request, context: Context) {
  try {
    const { subject } = await context.params;
    return Response.json(await (await engineClient()).spoolLook(subject));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
