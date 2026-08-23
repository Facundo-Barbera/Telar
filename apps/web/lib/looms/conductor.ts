import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { EngineClient } from "@telar/engine-client";
import { appendJournal, getLoom, loomState, readJournal, readSpec, saveLoom, type Loom } from "./store";
import { runLoomVerification } from "./verify";

const exec = promisify(execFile);

/**
 * THE EPISODIC CONDUCTOR — docs/method-contract-v0.md, v0.1.
 *
 * An agent that steers, with long-lived STATE instead of long-lived CONTEXT.
 * Each episode boots from the loom document (spec.md + journal.md + live
 * thread status), makes exactly ONE move, writes its decision and reasoning
 * back into the journal, and dies. No compaction, because there is nothing
 * to compact: what the conductor knows is exactly what is written down,
 * which is exactly what the human can read. The forgetting is auditable.
 *
 * THE CONDUCTOR PROPOSES; THE MACHINE EXECUTES. The agent returns a typed
 * decision and this module applies it through the same code paths the UI
 * uses — the verify it triggers is the identical clean-desk gate, the nudge
 * is an ordinary turn. It has no tools of its own, so it cannot invent a
 * softer path around the moat: `accept` is not in its vocabulary at all.
 */

export type ConductorMove =
  | { move: "wait"; reason: string }
  | { move: "verify"; reason: string }
  | { move: "nudge"; thread: string; message: string; reason: string }
  | { move: "escalate"; message: string; reason: string };

export interface EpisodeResult {
  decision: ConductorMove;
  applied: boolean;
  detail?: string;
}

/** Throttle: a conductor that can be re-woken every poll would burn tokens
 *  restating "wait". One episode per minute is plenty for v0's triggers. */
export const CONDUCT_COOLDOWN_MS = 60_000;

async function gatherBriefing(loom: Loom, client: EngineClient): Promise<string> {
  const threads = await Promise.all(
    loom.threads.map(async (t) => {
      if (!t.sessionId) return `- ${t.slug}: PLANNED, not spawned (tier: ${t.tier ?? "none"})`;
      const snapshot = await client.session(t.sessionId).catch(() => null);
      if (!snapshot) return `- ${t.slug}: session unreachable`;
      const last = snapshot.items.filter((i) => i.title).at(-1)?.title ?? "(no acts yet)";
      const verification = t.verification
        ? `verification: ${t.verification.tier} ${t.verification.ok ? "GREEN" : "RED"}${t.verification.detail ? ` — ${t.verification.detail.slice(0, 150)}` : ""}`
        : "not verified yet";
      return `- ${t.slug} [${snapshot.session.activity}] last act: ${last.slice(0, 120)} | ${verification} | branch ${t.branch ?? "?"}`;
    }),
  );
  return [
    `# Loom: ${loom.title} (state: ${loomState(loom)})`,
    `Objective: ${loom.objective}`,
    `\n## Spec\n${readSpec(loom.id)?.slice(0, 4000) ?? "(none)"}`,
    `\n## Threads (live)\n${threads.join("\n")}`,
    `\n## Journal (most recent last)\n${readJournal(loom.id, 40) || "(empty)"}`,
  ].join("\n");
}

function parseDecision(raw: string): ConductorMove | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as ConductorMove;
    if (parsed.move === "wait" || parsed.move === "verify") return parsed;
    if (parsed.move === "nudge" && typeof parsed.thread === "string" && typeof parsed.message === "string") return parsed;
    if (parsed.move === "escalate" && typeof parsed.message === "string") return parsed;
    return null;
  } catch {
    return null;
  }
}

export async function conductEpisode(loomId: string, client: EngineClient): Promise<EpisodeResult> {
  const loom = getLoom(loomId);
  if (!loom) throw new Error(`no loom ${loomId}`);
  const state = loomState(loom);
  if (state === "accepted" || state === "waiting") {
    // An accepted loom is done; a waiting one is waiting for a HUMAN — a
    // conductor that "handled" a human gate would be the moat leaking.
    return { decision: { move: "wait", reason: `loom is ${state}; nothing for a conductor here` }, applied: false };
  }

  const briefing = await gatherBriefing(loom, client);
  const prompt = [
    "Sos el conductor de un loom de Telar: el agente que STEERS, no el que trabaja.",
    briefing,
    "Decidí UN movimiento y nada más:",
    '- {"move":"wait","reason":"..."} — todo avanza solo; no molestar.',
    '- {"move":"verify","reason":"..."} — los threads parecen terminados (idle + trabajo commiteado); correr la verificación de escritorio limpio.',
    '- {"move":"nudge","thread":"<slug>","message":"...","reason":"..."} — un thread está trabado o se desvió; mandale UN mensaje concreto.',
    '- {"move":"escalate","message":"...","reason":"..."} — esto necesita un humano (contrato imposible, verificación roja repetida, conflicto entre threads).',
    "No existe ningún movimiento que acepte el loom ni cierre issues — eso es del humano, siempre.",
    "Respondé SOLO el JSON.",
  ].join("\n\n");

  const { stdout } = await exec("claude", ["-p", prompt, "--output-format", "json", "--model", "sonnet", "--max-turns", "1"], {
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  const envelope = JSON.parse(stdout) as { result?: string; is_error?: boolean };
  const decision = envelope.result ? parseDecision(envelope.result) : null;
  if (!decision) {
    appendJournal(loomId, "conductor", `episode produced no parseable decision: ${(envelope.result ?? "").slice(0, 120)}`);
    const fallback: ConductorMove = { move: "wait", reason: "unparseable episode output" };
    saveLoom({ ...loom, conductedAt: Date.now() });
    return { decision: fallback, applied: false };
  }

  appendJournal(loomId, "conductor", `${decision.move}: ${decision.reason}`);

  let applied = true;
  let detail: string | undefined;
  switch (decision.move) {
    case "wait":
      break;
    case "verify": {
      await runLoomVerification(getLoom(loomId)!, client);
      break;
    }
    case "nudge": {
      const thread = loom.threads.find((t) => t.slug === decision.thread);
      if (thread?.sessionId) {
        await client.submitTurn(thread.sessionId, {
          runId: randomUUID(),
          input: `(nudge del conductor del loom) ${decision.message}`,
        });
      } else {
        applied = false;
        detail = `no spawned thread "${decision.thread}"`;
      }
      break;
    }
    case "escalate": {
      saveLoom({ ...getLoom(loomId)!, attention: decision.message });
      break;
    }
  }
  const after = getLoom(loomId)!;
  saveLoom({ ...after, conductedAt: Date.now() });
  return { decision, applied, ...(detail ? { detail } : {}) };
}
