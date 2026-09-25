import type { CleanupPolicy } from "@telar/engine-client";
import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * The automatic cleanup's switches and its last result — Settings → Storage.
 * PUT takes a partial policy and answers with the whole state.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    return Response.json(await (await engineClient()).cleanup());
  } catch (error) {
    return engineErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const patch = (await request.json()) as Partial<CleanupPolicy>;
    return Response.json(await (await engineClient()).setCleanupPolicy(patch));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
