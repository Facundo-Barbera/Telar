import { engineClient, engineRoute } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string; noteId: string }> };

/** Scoped by project, like the mcp-servers delete beside it: a note id is unique
 *  in practice, but addressing one through the notebook it belongs to is what
 *  keeps "this project's note" from becoming "whichever note has that id". */
export const GET = engineRoute(async (_request: Request, context: Context) => {
  const { projectId, noteId } = await context.params;
  return Response.json(await (await engineClient()).projectNote(projectId, noteId));
});

/** Title, body, pin, order. The engine refuses a patch that names `author` —
 *  provenance is stamped once — and the sentence comes back whole. */
export const PATCH = engineRoute(async (request: Request, context: Context) => {
  const { projectId, noteId } = await context.params;
  const patch = (await request.json()) as { title?: string; body?: string; pinned?: boolean; order?: number };
  return Response.json(await (await engineClient()).updateProjectNote(projectId, noteId, patch));
});

export const DELETE = engineRoute(async (_request: Request, context: Context) => {
  const { projectId, noteId } = await context.params;
  return Response.json(await (await engineClient()).deleteProjectNote(projectId, noteId));
});
