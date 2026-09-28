import { engineClient, requestObject, requiredString, engineRoute } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string }> };

/** Probe one interpreter or venv directory a person named. */
export const POST = engineRoute(async (request: Request, context: Context) => {
  const { projectId } = await context.params;
  const body = await requestObject(request);
  return Response.json(await (await engineClient()).dataScienceProbe(projectId, requiredString(body.path, "Python path")));
});
