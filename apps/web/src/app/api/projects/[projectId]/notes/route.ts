import { engineClient, engineRoute } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string }> };

/**
 * The project's notebook — the composer's foot and the `@` menu read this.
 *
 * Thin proxy, like every route here: the notebook is the engine's, on the
 * engine's disk, and the user's other app writes to the same store over
 * `/v2/notes/mcp`. Nothing is cached on this side; a note written elsewhere must
 * not be hidden behind a copy this process is holding.
 */
export const GET = engineRoute(async (_request: Request, context: Context) => {
  const { projectId } = await context.params;
  return Response.json(await (await engineClient()).projectNotes(projectId));
});

/** No `author` is forwarded: an absent one means the human's, which is what a
 *  write from this app always is. Only the engine's tool wall says "session". */
export const POST = engineRoute(async (request: Request, context: Context) => {
  const { projectId } = await context.params;
  const input = (await request.json()) as { title: string; body?: string; pinned?: boolean };
  return Response.json(await (await engineClient()).createProjectNote(projectId, input));
});
