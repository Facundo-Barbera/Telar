import { engineClient, engineErrorResponse } from "@/platform/engine/server";

/**
 * Resolve or unresolve one review thread — #842.
 *
 * FORWARDED, NOT VALIDATED: the daemon matches the thread id as a GitHub node id
 * and checks the body, so an in-process caller cannot walk past a check that only
 * ran here.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string; number: string; threadId: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const { projectId, number, threadId } = await context.params;
    const input = (await request.json()) as { resolved?: unknown };
    return Response.json(await (await engineClient()).resolveProjectThread(projectId, Number(number), threadId, input.resolved === true));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
