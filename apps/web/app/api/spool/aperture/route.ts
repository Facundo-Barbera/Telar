import { SpoolApertureView } from "@telar/engine-client";
import { engineClient, engineErrorResponse, requestObject } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * THE ROOM'S SMART VIEW — loops §8.1's shared slot. One current value, no
 * history: the chat's `spool_set_aperture` and the hand's Today/Scheduled
 * clicks write the same slot, so neither can drift from the other. A store
 * that was never written reads as "everything" — the ordinary wide room.
 */
export async function GET() {
  try {
    return Response.json(await (await engineClient()).spoolAperture());
  } catch (error) {
    return engineErrorResponse(error);
  }
}

/** PUT because it replaces the one whole value — idempotent, last writer
 *  wins. The view set stays CLOSED: a token from the engine's own enum,
 *  guarded here in the same words the engine would refuse with. */
export async function PUT(request: Request) {
  try {
    const body = await requestObject(request);
    const view = body.view;
    if (!SpoolApertureView.options.includes(view as SpoolApertureView)) {
      return Response.json(
        { error: `view must be one of ${SpoolApertureView.options.join(", ")} — got ${JSON.stringify(view)}.` },
        { status: 400 },
      );
    }
    return Response.json(await (await engineClient()).setSpoolAperture(view as SpoolApertureView));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
