import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/** Sweep now with the current switches. Answers when the sweep is done. */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  try {
    return Response.json(await (await engineClient()).runCleanup());
  } catch (error) {
    return engineErrorResponse(error);
  }
}
