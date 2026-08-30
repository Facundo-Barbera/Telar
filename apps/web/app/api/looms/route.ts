import { engineClient, engineErrorResponse, requestObject, requiredString, optionalString } from "@/lib/engine/engine-server";
import { listLooms, newLoom, slugify, uniqueLoomSlug, type LoomThread } from "@/lib/looms/store";
import { displayState, threadStatus } from "@/lib/looms/status";
import { spawnThreads } from "@/lib/looms/spawn";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Looms joined with each thread's live session status. */
export async function GET() {
  try {
    const client = await engineClient();
    const looms = await Promise.all(
      listLooms().map(async (loom) => {
        const threads = await Promise.all(
          loom.threads.map(async (thread) => {
            const snapshot = thread.sessionId ? await client.session(thread.sessionId).catch(() => null) : null;
            const session = snapshot
              ? {
                  status: threadStatus(snapshot.session.activity, snapshot.session.state),
                  // The raw activity rides along so the UI can render it with
                  // the SAME badge language as every session row, instead of
                  // inventing a dialect from the folded status string.
                  activity: snapshot.session.activity,
                  activityAt: snapshot.session.activityAt ?? null,
                  updatedAt: snapshot.session.updatedAt,
                  title: snapshot.session.title,
                  worktree: snapshot.session.workspace?.path ?? null,
                }
              : null;
            return { ...thread, session };
          }),
        );
        return {
          ...loom,
          state: displayState(loom, threads.map((t) => t.session?.status ?? "unreachable")),
          threads,
        };
      }),
    );
    return Response.json({ looms });
  } catch (error) {
    return engineErrorResponse(error);
  }
}

/**
 * Create a loom — the moment of DETACHMENT (docs/loom-model-v1.md).
 *
 * Threads spawn as worktree sessions on branches named after the work
 * (`loom/<loom-slug>/<thread-slug>`), each brief carrying its contract, its
 * tier, and the loom rules. If the loom was spun from a conversation,
 * `originSessionId` moves that session into the loom's home too — from here
 * on, none of these sessions appear on the ordinary sessions surface.
 */
export async function POST(request: Request) {
  try {
    const body = await requestObject(request);
    const projectId = requiredString(body.projectId, "projectId");
    const title = requiredString(body.title, "title");
    const objective = requiredString(body.objective, "objective");
    const originSessionId = optionalString(body.originSessionId, "originSessionId");
    const client = await engineClient();
    const loomSlug = uniqueLoomSlug(slugify(title), listLooms());
    const threads: LoomThread[] = [];

    if (originSessionId) {
      // Detachment must not orphan a ghost: the origin has to exist.
      await client.session(originSessionId);
    }

    if (Array.isArray(body.threads)) {
      const usedSlugs = new Set<string>();
      for (const raw of body.threads as Array<Record<string, unknown>>) {
        const threadTitle = requiredString(raw.title, "thread title");
        const brief = requiredString(raw.brief, "thread brief");
        const contract = optionalString(raw.contract, "thread contract");
        const tier = optionalString(raw.tier, "thread tier");
        let slug = optionalString(raw.slug, "thread slug") ?? slugify(threadTitle);
        while (usedSlugs.has(slug)) slug = `${slug}-2`;
        usedSlugs.add(slug);
        threads.push({ slug, title: threadTitle, brief, ...(contract ? { contract } : {}), ...(tier ? { tier } : {}) });
      }
    }

    if (threads.length === 0) {
      return Response.json({ error: { code: "invalid_request", message: "a loom needs threads — pass threads[]" } }, { status: 400 });
    }
    // The one spawner (lib/looms/spawn.ts) — this legacy path used to carry
    // its own copy of the briefs, which drifted (it still spoke Spanish after
    // the machine went English). One code path, one voice.
    const loom = newLoom({ title, objective, projectId, threads, slug: loomSlug, ...(originSessionId ? { originSessionId } : {}) });
    return Response.json(await spawnThreads(loom, client), { status: 201 });
  } catch (error) {
    return engineErrorResponse(error);
  }
}
