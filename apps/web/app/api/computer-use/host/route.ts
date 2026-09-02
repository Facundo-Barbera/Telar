import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Wake the Sky host app in the background. Idempotent. */
export async function POST() {
  try {
    return Response.json(await (await engineClient()).wakeComputerUseHost());
  } catch (error) {
    return engineErrorResponse(error);
  }
}
