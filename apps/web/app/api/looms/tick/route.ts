import { engineClient, engineErrorResponse, requestObject, requiredString } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Run one tick — and answer 202 with the run rather than awaiting it.
 *
 * THE SPLIT IS NOT STYLE. Awaiting a whole tick here is the mistake
 * `/api/spool/night` made and paid for: the browser gave up and reported the
 * engine unreachable while the daemon happily finished the work. The run record
 * is the receipt, and `GET /api/looms/work` is where progress is read.
 */
export async function POST(request: Request) {
  try {
    const body = await requestObject(request);
    return Response.json(await (await engineClient()).tickLoom(requiredString(body.projectId, "projectId")), { status: 202 });
  } catch (error) {
    return engineErrorResponse(error);
  }
}
