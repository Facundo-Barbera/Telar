import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * ONE issue, opened.
 *
 * A 200 EVEN WHEN THERE IS NOTHING TO SHOW. The engine answers `{ issue }` or
 * `{ unavailable, message? }`, and all five kinds of nothing — gh missing, gh
 * logged out, not a GitHub repository, gh failed, no such issue — are answers
 * with their own sentence. Turning them into 4xx here would push them through the
 * cockpit's generic error path, which can only say "the request failed".
 *
 * `Number()` ON A `[number]` SEGMENT, and the engine is what rejects a bad one:
 * this route does not get to decide what a valid issue number is, because the
 * daemon has to make that decision anyway for callers that never come through
 * here.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string; number: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const { projectId, number } = await context.params;
    const refresh = new URL(request.url).searchParams.get("refresh") === "1";
    return Response.json(await (await engineClient()).projectIssue(projectId, Number(number), { refresh }));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
