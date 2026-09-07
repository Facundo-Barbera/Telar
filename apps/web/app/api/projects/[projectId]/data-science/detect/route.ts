import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string }> };

/** The Pythons a project could use, probed. Spawns interpreters — dialog-only. */
export async function GET(_request: Request, context: Context) {
  try {
    const { projectId } = await context.params;
    return Response.json(await (await engineClient()).dataScienceDetect(projectId));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
