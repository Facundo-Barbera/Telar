import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * THE MAP — every subject's open questions in one read.
 *
 * ONE CALL AND NOT ONE PER SUBJECT, the rule `/api/spool` already states: these
 * are projections of the same items and the same digests, so fetching them
 * separately could draw one subject's weave a tick apart from another's with no
 * way to tell staleness from disagreement.
 */
export async function GET() {
  try {
    return Response.json(await (await engineClient()).spoolMap());
  } catch (error) {
    return engineErrorResponse(error);
  }
}
