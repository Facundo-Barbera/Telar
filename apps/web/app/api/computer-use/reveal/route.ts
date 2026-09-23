import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Show Telar's bundled computer-use helper in Finder, so it can be dragged
 *  into a Privacy & Security list that does not name it yet. */
export async function POST() {
  try {
    return Response.json(await (await engineClient()).revealComputerUseHelper());
  } catch (error) {
    return engineErrorResponse(error);
  }
}
