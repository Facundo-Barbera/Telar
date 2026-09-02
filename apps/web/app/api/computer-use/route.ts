import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * Computer use, measured on request — the engine runs one real read-only call
 * through the Sky client, so this is slow by design (a subprocess round trip)
 * and never cached: the whole point is the CURRENT answer, and the probe is
 * also what makes macOS raise its Automation prompt when the grant is still
 * undecided.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    return Response.json(await (await engineClient()).computerUseStatus());
  } catch (error) {
    return engineErrorResponse(error);
  }
}
