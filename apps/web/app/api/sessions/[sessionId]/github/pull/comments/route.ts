import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";
import type { GitHubLineCommentInput } from "@telar/engine-client";

/**
 * Start a review thread on the session branch's pull request — #1014.
 *
 * FORWARDED, NOT VALIDATED: the daemon parses the line, side and commit, and looks
 * the pull request up from the session's own branch, so an in-process caller
 * cannot walk past a check that only ran here.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ sessionId: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const { sessionId } = await context.params;
    const input = (await request.json()) as GitHubLineCommentInput;
    return Response.json(await (await engineClient()).commentOnSessionPullLine(sessionId, input));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
