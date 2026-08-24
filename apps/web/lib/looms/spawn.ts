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

    // MACHINE PROMPTS ARE ENGLISH; the WORK speaks the project's language.
    // Telar is an English tool — but the brief itself comes from the weaver,
    // which is told to write it in the repo's language, and the closing line
    // asks the agent to keep answering in kind. Language is content, never
    // machinery. (The first version had these rules in Spanish — an accident
    // of dogfooding on a Spanish repo that had leaked into the machine.)
    const parts = [thread.brief];
    if (thread.contract) {
      parts.push(`Verification contract (your work is accepted only if this is demonstrable):\n${thread.contract}`);
    }
    if (thread.tier) {
      parts.push(
        `Verification tier: "${thread.tier}". The loom will run it with telar-env against a CLEAN checkout of your branch — uncommitted work does not exist. You may run it yourself (\`telar-env tier ${thread.tier}\`) while working, but only the loom's run counts.`,
      );
    }
    parts.push(
      "Loom rules: work in your own worktree; never touch main; do NOT close issues (a human closes them after verifying); commit your work (atomic commits); finish with a scoped diff + verification steps + honest leftovers. Write everything addressed to the work — commits, comments, reports — in the project's own language.",
    );
    await client.submitTurn(thread.sessionId, { runId: randomUUID(), input: parts.join("\n\n") });
    appendJournal(loom.id, "machine", `spawned thread ${thread.slug} as ${thread.sessionId} on ${thread.branch ?? "?"}`);
  }
  return saveLoom(loom);
}
