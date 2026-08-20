import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The Spool's project-less master chat, ensured.
 *
 * A GET THAT MAY WRITE, which is the one thing worth flagging about it. CAP-1
 * says there is ONE project-less conversation and it is the module's front door,
 * so the honest verb is "give me the front door" — and the first caller ever to
 * ask has to mint it. A POST would push that decision onto every surface that
 * merely wants to render the door, and a "create master chat" button would turn
 * the front door into a list of front doors.
 *
 * IDEMPOTENT, therefore safe on every page load: the engine returns the existing
 * project-less session if one exists and mints it otherwise. Two tabs opening at
 * once get the same session, not two.
 */
export async function GET() {
  try {
    return Response.json(await (await engineClient()).spoolMaster());
  } catch (error) {
    return engineErrorResponse(error);
  }
}
