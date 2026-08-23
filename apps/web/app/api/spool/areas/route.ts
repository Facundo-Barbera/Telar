import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * THE STATED CEILINGS — loops §8.1. Only areas someone stated a ceiling for
 * (or minted by stating one) appear here; an area that exists purely as a
 * `subject.area` string has no record, because a ceiling is a statement the
 * user made and never a default the system assumed. The permits face renders
 * the absent ones as "no ceiling" for exactly that reason.
 */
export async function GET() {
  try {
    return Response.json(await (await engineClient()).spoolAreas());
  } catch (error) {
    return engineErrorResponse(error);
  }
}
