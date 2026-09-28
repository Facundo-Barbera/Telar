import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string }> };

/**
 * The project's PROMPT SHELF — unsent messages kept by name, which the
 * composer's stash draws.
 *
 * Thin proxy, like every route here, and uncached for a sharper version of the
 * notebook's reason: the other writer is not another app, it is a WORKER, and it
 * writes while you are watching the turn that does it. A copy held in this
 * process would hide a follow-up an agent drafted a second ago.
 *
 * Answers the whole project's shelf; the composer narrows it to its own session
 * (`mergeShelf`), because the count and the list want different things.
 */
export async function GET(_request: Request, context: Context) {
  try {
    const { projectId } = await context.params;
    return Response.json(await (await engineClient()).projectPrompts(projectId));
  } catch (error) {
    return engineErrorResponse(error);
  }
}

/** No `author` is forwarded: an absent one means the human's, which is what a
 *  write from this app always is. Only the engine's tool wall says "session". */
export async function POST(request: Request, context: Context) {
  try {
    const { projectId } = await context.params;
    const input = (await request.json()) as { title: string; text: string; reason?: string; sessionId?: string };
    return Response.json(await (await engineClient()).createProjectPrompt(projectId, input));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
