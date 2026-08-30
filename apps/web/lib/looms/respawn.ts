import type { EngineClient } from "@telar/engine-client";
import { appendEvent, getLoom, saveLoom } from "./store";
import { spawnThreads } from "./spawn";

/**
 * RE-SEEDING — the loom's one recovery point, shared by the human's Restart
 * button and the conductor's `respawn` move so both go through the same
 * guard: a GREEN-VERIFIED thread is never respawned. Green means the branch
 * carries accepted-grade evidence; respawning would reset it, and that one
 * irreversible edge belongs to the machine, not to anyone's judgment —
 * human or conductor alike.
 *
 * Dead sessions are archived (worktree freed, branch kept), the thread
 * returns to being a plan, and spawnThreads gives it a fresh session from
 * the same brief, contract and branch name.
 */
export async function respawnLoomThreads(
  loomId: string,
  client: EngineClient,
  opts: { threads?: string[]; actor: "human" | "conductor" },
): Promise<{ respawned: string[]; refused: string[] }> {
  const loom = getLoom(loomId);
  if (!loom) throw new Error(`no loom ${loomId}`);

  const targets =
    opts.threads ?? loom.threads.filter((t) => t.sessionId && !t.verification?.ok).map((t) => t.slug ?? t.title);
  const respawned: string[] = [];
  const refused: string[] = [];

  for (const slug of targets) {
    const thread = loom.threads.find((t) => (t.slug ?? t.title) === slug);
    if (!thread) {
      refused.push(`${slug} (unknown)`);
      continue;
    }
    if (thread.verification?.ok) {
      refused.push(`${slug} (verified green)`);
      continue;
    }
    if (thread.sessionId) {
      await client.archiveSession(thread.sessionId).catch(() => undefined);
      delete thread.sessionId;
      delete thread.verification;
    }
    respawned.push(slug);
  }
  saveLoom(loom);

  if (respawned.length > 0) {
    appendEvent(loomId, {
      actor: opts.actor,
      kind: "note",
      detail: `re-seeding ${respawned.join(", ")} — dead sessions retired, fresh ones from the same plans`,
    });
    await spawnThreads(getLoom(loomId)!, client);
  }
  if (refused.length > 0) {
    appendEvent(loomId, { actor: "machine", kind: "note", detail: `respawn refused for ${refused.join(", ")}` });
  }
  return { respawned, refused };
}
