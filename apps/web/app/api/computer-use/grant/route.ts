import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Kick off cua's native granting flow. Returns immediately; the grant dialogs
 *  are CuaDriver.app's. */
export async function POST() {
  try {
    return Response.json(await (await engineClient()).grantComputerUseAccess());
  } catch (error) {
    return engineErrorResponse(error);
  }
}
