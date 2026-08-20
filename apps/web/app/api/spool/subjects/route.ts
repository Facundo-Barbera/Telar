import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The Spool's subjects — what an item is ABOUT, and what an expert belongs to.
 *
 * A `GET` THAT MAY WRITE, which is unusual enough to justify, and the same
 * reasoning `/v2/spool/master` already carries: reading is how the derivation
 * runs. A subject an item names and nothing has registered is created here, so
 * there is no boot migration to leave half-done and no state where the registry
 * disagrees with the packets. It is idempotent and touches no packet.
 */
export async function GET() {
  try {
    return Response.json(await (await engineClient()).spoolSubjects());
  } catch (error) {
    return engineErrorResponse(error);
  }
}
