import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Every subject's STORED look — what the Spool last saw, honestly stale
 * (`fresh: false` on each), with no network read on the engine side. This is
 * the arrival read: the room paints instantly from it and lets freshness
 * arrive through POST /api/spool/look afterwards.
 */
export async function GET() {
  try {
    return Response.json(await (await engineClient()).spoolLooks());
  } catch (error) {
    return engineErrorResponse(error);
  }
}
