import type { DataScienceCreateEnvironment } from "@telar/engine-client";
import { engineClient, engineErrorResponse, requestObject } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string }> };

/** Every environment the project could run on, probed. Spawns interpreters — page-only. */
export async function GET(_request: Request, context: Context) {
  try {
    const { projectId } = await context.params;
    return Response.json(await (await engineClient()).dataScienceEnvironments(projectId));
  } catch (error) {
    return engineErrorResponse(error);
  }
}

/** Start making one; the engine validates the shape and answers with a job id. */
export async function POST(request: Request, context: Context) {
  try {
    const { projectId } = await context.params;
    const body = (await requestObject(request)) as unknown as DataScienceCreateEnvironment;
    return Response.json(await (await engineClient()).dataScienceCreateEnvironment(projectId, body));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
