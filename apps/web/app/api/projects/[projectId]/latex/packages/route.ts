import { engineClient, engineErrorResponse, requestObject } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const { projectId } = await context.params;
    return Response.json(await (await engineClient()).latexPackages(projectId));
  } catch (error) {
    return engineErrorResponse(error);
  }
}

/** tlmgr install / remove, as a job. */
export async function POST(request: Request, context: Context) {
  try {
    const { projectId } = await context.params;
    const body = await requestObject(request);
    const list = (value: unknown) => (Array.isArray(value) ? value.map(String) : undefined);
    return Response.json(await (await engineClient()).latexInstall(projectId, {
      ...(list(body.add) ? { add: list(body.add)! } : {}),
      ...(list(body.remove) ? { remove: list(body.remove)! } : {}),
    }));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
