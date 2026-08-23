import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";
import { getLoom } from "@/lib/looms/store";
import { displayState, threadStatus } from "@/lib/looms/status";

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
        const status = threadStatus(snapshot.session.activity, snapshot.session.state);
        return {
          ...thread,
          live: {
            status,
            worktree: snapshot.session.workspace?.path ?? null,
            branch: snapshot.session.workspace?.mode === "worktree" ? snapshot.session.workspace.branch : null,
            lastAct: last?.title ?? null,
            lastActAt: last?.startedAt ?? null,
            // Task records outlive a dead engine; counting them while the
            // session is idle would resurrect the forever-working bug.
            openTasks: status === "working" ? snapshot.tasks.length : 0,
            itemCount: snapshot.items.length,
          },
        };
      }),
    );
    const origin = loom.originSessionId
      ? await client
          .session(loom.originSessionId)
          .then((s) => ({ sessionId: s.session.id, title: s.session.title }))
          .catch(() => ({ sessionId: loom.originSessionId!, title: "origin session" }))
      : null;
    return Response.json({
      ...loom,
      state: displayState(loom, threads.map((t) => t.live?.status ?? "unreachable")),
      threads,
      origin,
    });
  } catch (error) {
    return engineErrorResponse(error);
  }
}
