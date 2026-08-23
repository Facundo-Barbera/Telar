import { randomUUID } from "node:crypto";
import { engineClient, engineErrorResponse, requestObject, requiredString, optionalString } from "@/lib/engine/engine-server";
import { listLooms, loomState, newLoom, type LoomThread } from "@/lib/looms/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Looms joined with each thread's live session status. */
export async function GET() {
  try {
    const client = await engineClient();
    const looms = await Promise.all(
      listLooms().map(async (loom) => ({
        ...loom,
        state: loomState(loom),
        threads: await Promise.all(
          loom.threads.map(async (thread) => {
            const snapshot = await client.session(thread.sessionId).catch(() => null);
            const session = snapshot
              ? {
                  status: snapshot.tasks.length > 0 ? "working" : snapshot.session.state,
                  title: snapshot.session.title,
                  worktree: snapshot.session.workspace?.path ?? null,
                }
              : null;
            return { ...thread, session };
          }),
        ),
      })),
    );
    return Response.json({ looms });
  } catch (error) {
    return engineErrorResponse(error);
  }
}

/**
 * Create a loom: decompose an objective into threads, one worktree session
 * each, every brief carrying the loom rules. Or adopt already-running
 * sessions into a loom (`adoptSessionIds`).
 */
export async function POST(request: Request) {
  try {
    const body = await requestObject(request);
    const projectId = requiredString(body.projectId, "projectId");
    const title = requiredString(body.title, "title");
    const objective = requiredString(body.objective, "objective");
    const client = await engineClient();
    const threads: LoomThread[] = [];

    if (Array.isArray(body.adoptSessionIds)) {
      for (const sessionId of body.adoptSessionIds as string[]) {
        const snapshot = await client.session(sessionId);
        threads.push({
          sessionId,
          title: snapshot.session.title || sessionId,
          brief: "(adopted from a running session)",
        });
      }
    }

    if (Array.isArray(body.threads)) {
      for (const raw of body.threads as Array<Record<string, unknown>>) {
        const threadTitle = requiredString(raw.title, "thread title");
        const brief = requiredString(raw.brief, "thread brief");
        const created = await client.createSession({ projectId, title: threadTitle, envMode: "worktree" });
        const sessionId = created.session.id;
        await client.submitTurn(sessionId, { runId: randomUUID(), input: brief });
        threads.push({ sessionId, title: threadTitle, brief });
      }
    }

    if (threads.length === 0) {
      return Response.json(
        { error: { code: "invalid_request", message: "a loom needs threads — pass threads[] or adoptSessionIds[]" } },
        { status: 400 },
      );
    }
    const note = optionalString(body.note, "note");
    void note;
    return Response.json(newLoom({ title, objective, projectId, threads }), { status: 201 });
  } catch (error) {
    return engineErrorResponse(error);
  }
}
