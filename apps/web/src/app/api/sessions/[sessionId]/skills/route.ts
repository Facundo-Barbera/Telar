import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * What this session's provider can be asked to do — the composer's `$` menu and
 * the "Provider commands" half of its `/` menu.
 *
 * A PROXY AND NOTHING ELSE. The reading, the precedence between a project's
 * skills and the machine's, and the cache in front of both are the engine's
 * (`provider-skills.ts`); a second opinion here would be a second thing to keep
 * in step with the directory layout Claude Code actually uses.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ sessionId: string }> }) {
  try {
    const { sessionId } = await context.params;
    const engine = await engineClient();
    return Response.json(await engine.sessionSkills(sessionId));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
