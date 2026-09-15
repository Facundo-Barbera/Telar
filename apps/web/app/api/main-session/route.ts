import { requestObject, engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * Which conversation this Mac calls Main, and whether the designation is on —
 * experimental, off by default (#522).
 *
 * ENVIRONMENT-SCOPED, like the session defaults and the inbox rule beside it and
 * for the same reason: the desktop shell, a browser tab and a paired phone read
 * one engine, and a per-client copy would put the rail entry on one of them and
 * not the others.
 *
 * FORWARDED UNVALIDATED, also like those: designation is a ladder (an explicit
 * session, then whatever is already designated and exists, then a project to
 * create in) and it lives in the engine's store. A second copy of it here could
 * disagree, and disagreeing about this one means two coordinators.
 *
 * THE RAIL DOES NOT CALL THIS. It reads the same answer off `/api/sessions/live`,
 * which it already polls; this route is the settings pane's read and its write.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    return Response.json(await (await engineClient()).mainSession());
  } catch (error) {
    return engineErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await requestObject(request);
    return Response.json(
      await (await engineClient()).setMainSession({
        // By PRESENCE, like every other patch here: a client naming only a
        // session must not also be re-deciding the switch.
        ...("enabled" in body ? { enabled: body.enabled as boolean } : {}),
        ...("sessionId" in body ? { sessionId: body.sessionId as string } : {}),
        ...("projectId" in body ? { projectId: body.projectId as string } : {}),
      }),
    );
  } catch (error) {
    return engineErrorResponse(error);
  }
}
