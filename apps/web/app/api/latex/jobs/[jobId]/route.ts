import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ jobId: string }> };

/** A latex job by cursor: `?after=N` returns only the lines since. */
export async function GET(request: Request, context: Context) {
  try {
    const { jobId } = await context.params;
    const after = Number(new URL(request.url).searchParams.get("after") ?? "0");
    return Response.json(await (await engineClient()).latexJob(jobId, Number.isFinite(after) ? after : 0));
  } catch (error) {
    return engineErrorResponse(error);
  }
}

export async function DELETE(_request: Request, context: Context) {
  try {
    const { jobId } = await context.params;
    return Response.json(await (await engineClient()).latexCancelJob(jobId));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
