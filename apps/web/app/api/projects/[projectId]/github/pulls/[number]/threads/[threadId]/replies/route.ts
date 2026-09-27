import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * Reply to one review thread — #842.
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
    const input = (await request.json()) as { body?: unknown };
    return Response.json(await (await engineClient()).replyToProjectThread(projectId, Number(number), threadId, String(input.body ?? "")));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
