import { engineClient, engineRoute } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ jobId: string }> };

/** A latex job by cursor: `?after=N` returns only the lines since. */
export const GET = engineRoute(async (request: Request, context: Context) => {
  const { jobId } = await context.params;
  const after = Number(new URL(request.url).searchParams.get("after") ?? "0");
  return Response.json(await (await engineClient()).latexJob(jobId, Number.isFinite(after) ? after : 0));
});

export const DELETE = engineRoute(async (_request: Request, context: Context) => {
  const { jobId } = await context.params;
  return Response.json(await (await engineClient()).latexCancelJob(jobId));
});
