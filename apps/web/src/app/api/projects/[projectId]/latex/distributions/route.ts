import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string }> };

/** Every TeX distribution the machine carries plus main-file candidates. Spawns probes — page-only. */
export async function GET(_request: Request, context: Context) {
  try {
    const { projectId } = await context.params;
    return Response.json(await (await engineClient()).latexDistributions(projectId));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
