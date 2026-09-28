import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

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
export async function GET(_request: Request, context: Context) {
  try {
    const { projectId } = await context.params;
    return Response.json(await (await engineClient()).projectNotes(projectId));
  } catch (error) {
    return engineErrorResponse(error);
  }
}

/** No `author` is forwarded: an absent one means the human's, which is what a
 *  write from this app always is. Only the engine's tool wall says "session". */
export async function POST(request: Request, context: Context) {
  try {
    const { projectId } = await context.params;
    const input = (await request.json()) as { title: string; body?: string; pinned?: boolean };
    return Response.json(await (await engineClient()).createProjectNote(projectId, input));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
