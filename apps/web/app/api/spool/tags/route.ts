import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * EVERY TAG IN USE — items and notes both, alphabetised, with its two counts.
 * A read-time projection: there is no tag record on disk, see
 * `apps/engine/src/spool/tags.ts`.
 */
export async function GET() {
  try {
    return Response.json(await (await engineClient()).spoolTags());
  } catch (error) {
    return engineErrorResponse(error);
  }
}
