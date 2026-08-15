import { engineClient, engineErrorResponse, optionalString, requestObject, requiredString } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Lanes are DATA, never an enum — the user splits, renames and retires them as
 *  life demands, and this is the list that says what they currently are. */
export async function GET() {
  try {
    return Response.json(await (await engineClient()).spoolLanes());
  } catch (error) {
    return engineErrorResponse(error);
  }
}

/**
 * Mint a lane. HUMAN-ONLY: no tool surface reaches this, and the key is minted
 * from the label by the store rather than supplied here, so there is no path by
 * which two lanes could be asked to share one.
 */
export async function POST(request: Request) {
  try {
    const body = await requestObject(request);
    return Response.json(
      await (await engineClient()).createSpoolLane({
        label: requiredString(body.label, "label"),
        window: requiredString(body.window, "window"),
        ...(optionalString(body.note, "note") !== undefined ? { note: optionalString(body.note, "note")! } : {}),
      }),
    );
  } catch (error) {
    return engineErrorResponse(error);
  }
}
