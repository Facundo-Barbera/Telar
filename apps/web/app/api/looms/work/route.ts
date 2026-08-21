import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * WHAT IS RUNNING RIGHT NOW, across every project — the other half of the 202
 * that `POST /api/looms/tick` answers with. A tick can take minutes, so it is
 * begun by one request and WATCHED by this one; nothing streams.
 */
export async function GET() {
  try {
    return Response.json(await (await engineClient()).loomWork());
  } catch (error) {
    return engineErrorResponse(error);
  }
}
