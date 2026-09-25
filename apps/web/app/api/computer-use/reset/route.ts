import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Clear the macOS grants of Telar's bundled computer-use helper, and only
 *  its; `{ reset: false }` when there is no bundled helper to reset. */
export async function POST() {
  try {
    return Response.json(await (await engineClient()).resetComputerUseAccess());
  } catch (error) {
    return engineErrorResponse(error);
  }
}
