import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string }> };

/** Put a removed project back — same id, same settings, same sessions. Thin
 *  proxy; the engine owns the record. */
export async function POST(_request: Request, context: Context) {
  try {
    const { projectId } = await context.params;
    return Response.json(await (await engineClient()).restoreProject(projectId));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
