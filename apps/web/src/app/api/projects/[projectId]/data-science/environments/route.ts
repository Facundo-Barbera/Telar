import type { DataScienceCreateEnvironment } from "@telar/engine-client";
import { engineClient, requestObject, engineRoute } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string }> };

/** Every environment the project could run on, probed. Spawns interpreters — page-only. */
export const GET = engineRoute(async (_request: Request, context: Context) => {
  const { projectId } = await context.params;
  return Response.json(await (await engineClient()).dataScienceEnvironments(projectId));
});

/** Start making one; the engine validates the shape and answers with a job id. */
export const POST = engineRoute(async (request: Request, context: Context) => {
  const { projectId } = await context.params;
  const body = (await requestObject(request)) as unknown as DataScienceCreateEnvironment;
  return Response.json(await (await engineClient()).dataScienceCreateEnvironment(projectId, body));
});
