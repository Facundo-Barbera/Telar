import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Ask macOS for the grants and open the Settings pane to finish in, answering
 *  what happened. The dialogs name Telar's bundled helper, or an external cua
 *  install in dev. */
export async function POST() {
  try {
    return Response.json(await (await engineClient()).grantComputerUseAccess());
  } catch (error) {
    return engineErrorResponse(error);
  }
}
