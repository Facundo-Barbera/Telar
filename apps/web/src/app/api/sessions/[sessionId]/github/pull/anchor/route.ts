import { engineClient, engineErrorResponse } from "@/platform/engine/server";

/**
 * What placing a Diff line on this session branch's pull request needs — #1014.
 * The branch comes off the session record in the engine, so nothing is read here.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ sessionId: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const { sessionId } = await context.params;
    return Response.json(await (await engineClient()).sessionPullAnchor(sessionId));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
