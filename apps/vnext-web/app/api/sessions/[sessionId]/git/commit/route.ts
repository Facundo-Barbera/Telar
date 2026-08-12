import { requestObject, requiredString, vnextEngine, vnextErrorResponse } from "@/lib/vnext/engine-server";

/**
 * Snapshot the session's work as one commit.
 *
 * THE ONLY GIT MUTATION THE COCKPIT CAN PERFORM, and the shape is the rule for
 * any that follow: a human pressed it, it is additive, and a reset undoes it.
 * Staging, branch switching and discarding are absent by decision — see
 * `commitSessionWork` in apps/engine/src/git.ts.
 *
 * A REFUSED COMMIT IS A 200. "Nothing to commit" and "a pre-commit hook said no"
 * are answers about the repository, not failures of the request, and the surface
 * shows the reason. Only a broken request or an unreachable engine is an error.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ sessionId: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const [{ sessionId }, body] = await Promise.all([context.params, requestObject(request)]);
    const result = await (await vnextEngine()).commitSessionWork(sessionId, requiredString(body.message, "Commit message"));
    return Response.json(result);
  } catch (error) {
    return vnextErrorResponse(error);
  }
}
