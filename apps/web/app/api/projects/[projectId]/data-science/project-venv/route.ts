import { engineClient, engineErrorResponse, requestObject, requiredString } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string }> };

/** `uv venv .venv` inside the project. Slow with `stack: true`. */
export async function POST(request: Request, context: Context) {
  try {
    const { projectId } = await context.params;
    const body = await requestObject(request);
    return Response.json(
      await (await engineClient()).dataScienceProjectVenv(projectId, {
        basePython: requiredString(body.basePython, "Base python"),
        ...(typeof body.stack === "boolean" ? { stack: body.stack } : {}),
      }),
    );
  } catch (error) {
    return engineErrorResponse(error);
  }
}
