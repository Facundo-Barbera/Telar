import { randomUUID } from "node:crypto";
import { engineClient, engineErrorResponse, requestObject, requiredString, optionalString } from "@/lib/engine/engine-server";
import { listLooms, newLoom, slugify, uniqueLoomSlug, type LoomThread } from "@/lib/looms/store";
import { displayState, threadStatus } from "@/lib/looms/status";

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
            const snapshot = await client.session(thread.sessionId).catch(() => null);
            const session = snapshot
              ? {
                  status: threadStatus(snapshot.session.activity, snapshot.session.state),
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
        const created = await client.createSession({
          projectId,
          title: threadTitle,
          envMode: "worktree",
          branchSlug: `loom/${loomSlug}/${slug}`,
        });
        const sessionId = created.session.id;
        const branch = created.session.workspace?.mode === "worktree" ? created.session.workspace.branch : undefined;
        const parts = [brief];
        if (contract) {
          parts.push(`Contrato de verificación (tu trabajo se acepta solo si esto es demostrable):\n${contract}`);
        }
        if (tier) {
          parts.push(
            `Tier de verificación: "${tier}". El loom lo va a correr con telar-env sobre un checkout LIMPIO de tu rama — lo que no está commiteado no existe. Podés correrlo vos (\`telar-env tier ${tier}\`) mientras trabajás, pero solo cuenta la corrida del loom.`,
          );
        }
        parts.push(
          "Reglas loom: trabajás en tu propio worktree; no toques main; NO cierres issues (los cierra un humano tras verificar); commiteá tu trabajo (commits atómicos); terminá con diff acotado + pasos de verificación + pendientes honestos.",
        );
        await client.submitTurn(sessionId, { runId: randomUUID(), input: parts.join("\n\n") });
        threads.push({
          sessionId,
          slug,
          title: threadTitle,
          brief,
          ...(contract ? { contract } : {}),
          ...(tier ? { tier } : {}),
          ...(branch ? { branch } : {}),
        });
      }
    }

    if (threads.length === 0) {
      return Response.json({ error: { code: "invalid_request", message: "a loom needs threads — pass threads[]" } }, { status: 400 });
    }
    return Response.json(
      newLoom({ title, objective, projectId, threads, slug: loomSlug, ...(originSessionId ? { originSessionId } : {}) }),
      { status: 201 },
    );
  } catch (error) {
    return engineErrorResponse(error);
  }
}
