import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";
import { getLoom, loomState } from "@/lib/looms/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ loomId: string }> };

/**
 * The loom room's read: loom-native detail per thread, so the room can tell
 * the loom's story without sending the person into four chat transcripts.
 * `lastAct` is the newest titled item from the session journal — "what is it
 * doing right now" in one line.
 */
export async function GET(_request: Request, context: Context) {
  try {
    const { loomId } = await context.params;
    const loom = getLoom(loomId);
    if (!loom) return Response.json({ error: { code: "not_found", message: `no loom ${loomId}` } }, { status: 404 });
    const client = await engineClient();
    const threads = await Promise.all(
      loom.threads.map(async (thread) => {
        const snapshot = await client.session(thread.sessionId).catch(() => null);
        if (!snapshot) return { ...thread, live: null };
        const titled = snapshot.items.filter((i) => i.title);
        const last = titled.at(-1);
        const working = snapshot.tasks.length > 0 || snapshot.items.some((i) => i.status === "inProgress");
        return {
          ...thread,
          live: {
            status: working ? "working" : snapshot.session.state,
            worktree: snapshot.session.workspace?.path ?? null,
            branch: snapshot.session.workspace?.mode === "worktree" ? snapshot.session.workspace.branch : null,
            lastAct: last?.title ?? null,
            lastActAt: last?.startedAt ?? null,
            openTasks: snapshot.tasks.length,
            itemCount: snapshot.items.length,
          },
        };
      }),
    );
    return Response.json({ ...loom, state: loomState(loom), threads });
  } catch (error) {
    return engineErrorResponse(error);
  }
}
