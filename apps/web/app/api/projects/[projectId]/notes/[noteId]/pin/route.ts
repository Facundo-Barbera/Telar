import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string; noteId: string }> };

/** Its own route rather than a PATCH field, because it is one gesture from one
 *  control and the strip should not have to compose a patch to express a toggle. */
export async function POST(request: Request, context: Context) {
  try {
    const { projectId, noteId } = await context.params;
    const { pinned } = (await request.json()) as { pinned?: boolean };
    return Response.json(await (await engineClient()).pinProjectNote(projectId, noteId, pinned !== false));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
