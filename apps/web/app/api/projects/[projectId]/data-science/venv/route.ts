import { engineClient, engineErrorResponse, requestObject, requiredString } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string }> };

/** Build Telar's own venv for a project. Slow with `stack: true`; the dialog shows a spinner. */
export async function POST(request: Request, context: Context) {
  try {
    const { projectId } = await context.params;
    const body = await requestObject(request);
    return Response.json(
      await (await engineClient()).dataScienceVenv(projectId, {
        basePython: requiredString(body.basePython, "Base python"),
        ...(typeof body.stack === "boolean" ? { stack: body.stack } : {}),
      }),
    );
  } catch (error) {
    return engineErrorResponse(error);
  }
}
