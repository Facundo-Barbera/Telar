import { engineClient, engineRoute } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string }> };

/** Every TeX distribution the machine carries plus main-file candidates. Spawns probes — page-only. */
export const GET = engineRoute(async (_request: Request, context: Context) => {
  const { projectId } = await context.params;
  return Response.json(await (await engineClient()).latexDistributions(projectId));
});
