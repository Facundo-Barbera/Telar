import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";
import { loomOwnedSessionIds } from "@/lib/looms/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The whole inbox in one call: every active session across every project,
 * with the project names to label them. Built for remote clients (the phone)
 * where the sidebar's per-project fan-out costs a round-trip each.
 */
export async function GET() {
  try {
    const { sessions, projects } = await (await engineClient()).liveSessions();
    // DETACHMENT (docs/loom-model-v1.md): same subtraction as the per-project
    // list — loom-owned sessions do not exist on ordinary surfaces, and this
    // route is an ordinary surface.
    const owned = loomOwnedSessionIds();
    return Response.json({
      sessions: sessions.filter((session) => !owned.has(session.id)),
      projects,
    });
  } catch (error) {
    return engineErrorResponse(error);
  }
}
