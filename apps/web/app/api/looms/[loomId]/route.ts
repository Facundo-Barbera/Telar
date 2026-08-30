import { engineClient, engineErrorResponse, requestObject } from "@/lib/engine/engine-server";
import { appendEvent, deleteDraftLoom, getLoom, readJournal, readSpec, saveLoom } from "@/lib/looms/store";
import { displayState, threadStatus } from "@/lib/looms/status";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ loomId: string }> };

/**
 * The loom room's read: loom-native detail per thread, plus the loom
 * DOCUMENT — phases, spec, and the journal the conductor writes. The room
 * renders the same memory the conductor reboots from; there is no second
 * story.
 */
export async function GET(_request: Request, context: Context) {
  try {
    const { loomId } = await context.params;
    const loom = getLoom(loomId);
    if (!loom) return Response.json({ error: { code: "not_found", message: `no loom ${loomId}` } }, { status: 404 });
    const client = await engineClient();
    /** One liveness shape for EVERY member of the loom's population —
     *  threads, conductor, origin. The roster renders them identically
     *  because they are the same kind of thing: a session this loom owns. */
    const liveOf = async (sessionId: string | undefined) => {
      const snapshot = sessionId ? await client.session(sessionId).catch(() => null) : null;
      if (!snapshot) return null;
      const titled = snapshot.items.filter((i) => i.title);
      const last = titled.at(-1);
      const status = threadStatus(snapshot.session.activity, snapshot.session.state);
      return {
        status,
        activity: snapshot.session.activity,
        activityAt: snapshot.session.activityAt ?? null,
        updatedAt: snapshot.session.updatedAt,
        title: snapshot.session.title,
        worktree: snapshot.session.workspace?.path ?? null,
        branch: snapshot.session.workspace?.mode === "worktree" ? snapshot.session.workspace.branch : null,
        lastAct: last?.title ?? null,
        lastActAt: last?.startedAt ?? null,
        // Task records outlive a dead engine; counting them while the
        // session is idle would resurrect the forever-working bug.
        openTasks: status === "working" ? snapshot.tasks.length : 0,
        itemCount: snapshot.items.length,
      };
    };
    const threads = await Promise.all(loom.threads.map(async (thread) => ({ ...thread, live: await liveOf(thread.sessionId) })));
    const conductor = loom.conductorSessionId
      ? { sessionId: loom.conductorSessionId, live: await liveOf(loom.conductorSessionId) }
      : null;
    const originLive = loom.originSessionId ? await liveOf(loom.originSessionId) : null;
    const origin = loom.originSessionId
      ? { sessionId: loom.originSessionId, title: originLive?.title ?? "origin session", live: originLive }
      : null;
    return Response.json({
      ...loom,
      state: displayState(loom, threads.map((t) => t.live?.status ?? "unreachable")),
      threads,
      origin,
      conductor,
      spec: readSpec(loomId),
      journal: readJournal(loomId, 30),
    });
  } catch (error) {
    return engineErrorResponse(error);
  }
}

/** Discard a DRAFT — a loom whose gate was never cleared. Once sessions
 *  exist the loom is work, and work is not deleted by a button. */
export async function DELETE(_request: Request, context: Context) {
  try {
    const { loomId } = await context.params;
    if (!deleteDraftLoom(loomId)) {
      return Response.json(
        { error: { code: "conflict", message: "only a draft loom (no spawned threads) can be discarded" } },
        { status: 409 },
      );
    }
    return Response.json({ deleted: true });
  } catch (error) {
    return engineErrorResponse(error);
  }
}

/** The one mutable room fact: clearing the conductor's escalation flag once
 *  a human has seen it. */
export async function PATCH(request: Request, context: Context) {
  try {
    const [{ loomId }, body] = await Promise.all([context.params, requestObject(request)]);
    const loom = getLoom(loomId);
    if (!loom) return Response.json({ error: { code: "not_found", message: `no loom ${loomId}` } }, { status: 404 });
    if (body.clearAttention === true && loom.attention) {
      appendEvent(loomId, { actor: "human", kind: "seen", detail: `saw the escalation: ${loom.attention.slice(0, 120)}` });
      delete loom.attention;
      saveLoom(loom);
    }
    return Response.json(loom);
  } catch (error) {
    return engineErrorResponse(error);
  }
}
