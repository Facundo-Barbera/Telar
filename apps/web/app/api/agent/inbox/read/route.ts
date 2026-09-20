import { requestObject, engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * MARK INBOX ROWS READ, BY ID — issue #541, section A.
 *
 * BY ID AND NEVER "EVERYTHING", for the approval route's own reason: a client
 * holding a stale list must not be able to clear rows that landed after it last
 * looked. `read` is how many actually MOVED, so a second press of the same
 * button answers `0` rather than claiming a write that did nothing.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await requestObject(request);
    const ids = Array.isArray(body.ids) ? body.ids.filter((id: unknown): id is number => typeof id === "number") : undefined;
    if (!ids) return Response.json({ error: { code: "invalid_request", message: "ids must be a list of row ids" } }, { status: 400 });
    return Response.json(await (await engineClient()).markAgentInboxRead(ids));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
