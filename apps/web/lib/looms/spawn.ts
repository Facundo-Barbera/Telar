import { randomUUID } from "node:crypto";
import type { EngineClient } from "@telar/engine-client";
import { appendJournal, saveLoom, type Loom } from "./store";

/**
 * Spawning is what clearing the execute gate DOES — the moment a loom's
 * thread plans become sessions. Factored out of the routes so the approve
 * gate and any future dispatcher spawn identically: branch named after the
 * work, brief carrying contract + tier + loom rules, first turn submitted.
 */
export async function spawnThreads(loom: Loom, client: EngineClient): Promise<Loom> {
  for (const thread of loom.threads) {
    if (thread.sessionId) continue;
    const created = await client.createSession({
      projectId: loom.projectId,
      title: thread.title,
      envMode: "worktree",
      branchSlug: `loom/${loom.slug}/${thread.slug}`,
    });
    thread.sessionId = created.session.id;
    if (created.session.workspace?.mode === "worktree") thread.branch = created.session.workspace.branch;

    const parts = [thread.brief];
    if (thread.contract) {
      parts.push(`Contrato de verificación (tu trabajo se acepta solo si esto es demostrable):\n${thread.contract}`);
    }
    if (thread.tier) {
      parts.push(
        `Tier de verificación: "${thread.tier}". El loom lo va a correr con telar-env sobre un checkout LIMPIO de tu rama — lo que no está commiteado no existe. Podés correrlo vos (\`telar-env tier ${thread.tier}\`) mientras trabajás, pero solo cuenta la corrida del loom.`,
      );
    }
    parts.push(
      "Reglas loom: trabajás en tu propio worktree; no toques main; NO cierres issues (los cierra un humano tras verificar); commiteá tu trabajo (commits atómicos); terminá con diff acotado + pasos de verificación + pendientes honestos.",
    );
    await client.submitTurn(thread.sessionId, { runId: randomUUID(), input: parts.join("\n\n") });
    appendJournal(loom.id, "machine", `spawned thread ${thread.slug} as ${thread.sessionId} on ${thread.branch ?? "?"}`);
  }
  return saveLoom(loom);
}
