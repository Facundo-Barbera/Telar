import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * The person's own Claude Code conversations, as `/resume`'s picker lists them
 * (#616).
 *
 * A PROXY AND NOTHING ELSE. Which store is read depends on the session's login,
 * and resolving that — along with hiding the forks Telar has already adopted —
 * is the engine's job. A second opinion here would be a second thing to keep in
 * step with the directory layout Claude Code actually uses.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ sessionId: string }> }) {
  try {
    const { sessionId } = await context.params;
    return Response.json(await (await engineClient()).claudeConversations(sessionId));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
