import { engineClient, engineErrorResponse, requestObject, requiredString } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string }> };

/** Probe one interpreter or venv directory a person named. */
export async function POST(request: Request, context: Context) {
  try {
    const { projectId } = await context.params;
    const body = await requestObject(request);
    return Response.json(await (await engineClient()).dataScienceProbe(projectId, requiredString(body.path, "Python path")));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
