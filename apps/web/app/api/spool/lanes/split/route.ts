import { engineClient, engineErrorResponse, optionalString, requestObject, requiredString } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Split rows out of a lane into a new one — the shape CAP-4 describes when a
 * cluster crowds a lane.
 *
 * THE APPROVAL GATE IS STRUCTURAL, not a card. The master may PROPOSE a split;
 * only a human's click reaches this route, because no tool surface names the
 * verb behind it. "A master-proposed split takes effect only after explicit
 * human approval" is therefore true by construction rather than by a check
 * somebody has to remember.
 */
export async function POST(request: Request) {
  try {
    const body = await requestObject(request);
    const items = body.items;
    if (!Array.isArray(items) || items.some((id) => typeof id !== "string")) {
      return Response.json(
        { error: { code: "invalid_request", message: "a split names the item ids to move" } },
        { status: 400 },
      );
    }
    const note = optionalString(body.note, "note");
    return Response.json(
      await (await engineClient()).splitSpoolLane(
        requiredString(body.sourceKey, "sourceKey"),
        {
          label: requiredString(body.label, "label"),
          window: requiredString(body.window, "window"),
          ...(note !== undefined ? { note } : {}),
        },
        items as string[],
      ),
    );
  } catch (error) {
    return engineErrorResponse(error);
  }
}
