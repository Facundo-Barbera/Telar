import { engineClient, engineErrorResponse } from "@/platform/engine/server";
import type { GitHubReactionContent } from "@telar/engine-client";

/**
 * Add or remove one reaction — #842.
 *
 * FORWARDED, NOT VALIDATED, for the merge route's reason: the daemon refuses a
 * content or subject id that is not GitHub's shape, so an in-process caller cannot
 * walk past a check that only ran here.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string; number: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const { projectId, number } = await context.params;
    const input = (await request.json()) as { subjectId?: unknown; content?: unknown; react?: unknown };
    return Response.json(
      await (await engineClient()).reactOnProjectForge(projectId, "issue", Number(number), {
        subjectId: String(input.subjectId ?? ""),
        content: input.content as GitHubReactionContent,
        react: input.react as boolean,
      }),
    );
  } catch (error) {
    return engineErrorResponse(error);
  }
}
