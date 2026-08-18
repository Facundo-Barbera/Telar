import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Everything the Spool remembers — per subject, plus the front door's own.
 *
 * RETIRED FACTS COME BACK TOO. They are excluded from a model's PROMPT, never
 * from the human's view: "no deletion path. Dismissing drains" only means
 * anything if the drained thing stays legible. A surface that hid them would
 * make retirement indistinguishable from the deletion this store refuses.
 */
export async function GET() {
  try {
    return Response.json(await (await engineClient()).spoolMemory());
  } catch (error) {
    return engineErrorResponse(error);
  }
}
