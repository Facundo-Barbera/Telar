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
    const client = await engineClient();
    const [{ sessions, layout }, { projects }] = await Promise.all([client.liveSessions(), client.listProjects()]);
    // DETACHMENT (docs/loom-model-v1.md): same subtraction as the per-project
    // list — loom-owned sessions do not exist on ordinary surfaces, and this
    // route is an ordinary surface.
    const owned = loomOwnedSessionIds();
    return Response.json({
      sessions: sessions.filter((session) => !owned.has(session.id)),
      projects,
      // WHERE THE RAIL PUTS THINGS, forwarded rather than fetched again: this
      // is how a drag on the phone or another window reaches this one, on the
      // poll the rail was making anyway. Omitted by an engine that predates it.
      ...(layout ? { layout } : {}),
    });
  } catch (error) {
    return engineErrorResponse(error);
  }
}
