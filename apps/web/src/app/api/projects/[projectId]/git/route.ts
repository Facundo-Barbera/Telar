import { engineClient, engineRoute } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string }> };

/**
 * A project's git state, for the composer's pinned environment.
 *
 * Thin proxy, like every route here: the browser cannot run `git`, and the
 * engine already owns the project root and an injectable runner for it. Nothing
 * is cached on this side — the working tree changes underneath both processes,
 * and the line this feeds is what tells a person where their next message lands.
 */
export const GET = engineRoute(async (_request: Request, context: Context) => {
  const { projectId } = await context.params;
  return Response.json(await (await engineClient()).projectGit(projectId));
});
