import { engineClient, engineErrorResponse, requestObject, requiredString } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * A REAL TICK THAT DISPATCHES NOTHING — the trust surface at setup. Same code
 * path as `tick`, same detached 202, same run record: a separate "preview"
 * implementation would preview something other than what runs.
 */
export async function POST(request: Request) {
  try {
    const body = await requestObject(request);
    return Response.json(await (await engineClient()).dryRunLoom(requiredString(body.projectId, "projectId")), { status: 202 });
  } catch (error) {
    return engineErrorResponse(error);
  }
}
