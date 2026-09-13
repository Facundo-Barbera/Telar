import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * Ignore Telar's own files in a project's repository.
 *
 * THE ONLY ROUTE IN THIS ADAPTER THAT WRITES A FILE THE USER DID NOT NAME. Every
 * other write lands in the engine's state directory or in a file somebody opened
 * and edited on purpose; this one appends to a `.gitignore` inside their checkout.
 * So it takes NO BODY: the rules live in the engine
 * (`apps/engine/src/gitignore.ts`), and a route that accepted the lines would be a
 * route for appending anything to a file in any registered repository.
 *
 * The answer reports what was added and what an existing rule already covered,
 * because those are indistinguishable to a reader and mean opposite things.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string }> };

export async function POST(_request: Request, context: Context) {
  try {
    const { projectId } = await context.params;
    return Response.json(await (await engineClient()).projectGitignore(projectId));
  } catch (error) {
    return engineErrorResponse(error);
  }
}

/**
 * And the way back out — the Undo in the toast that reports the write.
 *
 * IT EXISTS BECAUSE THE WRITE STOPPED ASKING: adding a project ignores Telar's
 * files by default now (the switch in the old Register dialog became a default),
 * so a write nobody opted into needs a reverse as cheap as the way in. Bodyless
 * for the same reason the POST is: the engine decides what its own block was.
 */
export async function DELETE(_request: Request, context: Context) {
  try {
    const { projectId } = await context.params;
    return Response.json(await (await engineClient()).undoProjectGitignore(projectId));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
