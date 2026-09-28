import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * Publish this session's branch — issue #670.
 *
 * THE SECOND GIT MUTATION THE COCKPIT CAN PERFORM, and the first that leaves the
 * machine. The rule the commit route states still holds and is argued at length
 * in `apps/engine/src/git.ts`: a human pressed it, and it is additive — the argv
 * is fixed at `push --set-upstream origin <branch>`, so this can only ever
 * append commits to a branch the session itself created. There is no force, no
 * delete and no caller-supplied refspec anywhere behind this route, and
 * `scripts/source-invariants.mjs` fails the build if one appears.
 *
 * IT TAKES NO BODY, deliberately. The branch, the checkout and the remote are
 * the engine's to read off the session record; a request that could name a
 * branch could ask this engine to push any ref in any repository on this
 * machine.
 *
 * A REFUSED PUSH IS A 200, exactly as a refused commit is. "This checkout has no
 * origin", "nothing to push" and "the remote said no" are answers about the
 * repository, and the surface shows the reason. Only a broken request or an
 * unreachable engine is an error.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ sessionId: string }> };

export async function POST(_request: Request, context: Context) {
  try {
    const { sessionId } = await context.params;
    return Response.json(await (await engineClient()).pushSessionBranch(sessionId));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
