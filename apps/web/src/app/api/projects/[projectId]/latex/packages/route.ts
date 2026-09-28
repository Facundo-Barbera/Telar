import { engineClient, requestObject, engineRoute } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string }> };

export const GET = engineRoute(async (_request: Request, context: Context) => {
  const { projectId } = await context.params;
  return Response.json(await (await engineClient()).latexPackages(projectId));
});

/** tlmgr install / remove, as a job. */
export const POST = engineRoute(async (request: Request, context: Context) => {
  const { projectId } = await context.params;
  const body = await requestObject(request);
  const list = (value: unknown) => (Array.isArray(value) ? value.map(String) : undefined);
  return Response.json(await (await engineClient()).latexInstall(projectId, {
    ...(list(body.add) ? { add: list(body.add)! } : {}),
    ...(list(body.remove) ? { remove: list(body.remove)! } : {}),
  }));
});
