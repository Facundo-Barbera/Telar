import { engineClient, engineRoute } from "@/platform/engine/server";

/**
 * ONE pull request, opened — body, conversation, reviews, checks, and whether
 * GitHub will merge it.
 *
 * A 200 EVEN WHEN THERE IS NOTHING TO SHOW, for the reason the issue route beside
 * this one is: the five ways a detail read comes back empty are each a sentence a
 * reader can act on.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string; number: string }> };

export const GET = engineRoute(async (request: Request, context: Context) => {
  const { projectId, number } = await context.params;
  const refresh = new URL(request.url).searchParams.get("refresh") === "1";
  return Response.json(await (await engineClient()).projectPull(projectId, Number(number), { refresh }));
});
