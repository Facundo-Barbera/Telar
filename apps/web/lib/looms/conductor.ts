import { randomUUID } from "node:crypto";
import type { EngineClient } from "@telar/engine-client";
import { appendJournal, getLoom, loomState, readJournal, readSpec, saveLoom, type Loom } from "./store";
import { runLoomVerification } from "./verify";

/**
 * THE CONDUCTOR — an agent that steers, hosted in a SESSION OF ITS OWN.
 *
 * Still episodic in the way that matters (docs/method-contract-v0.md v0.1):
 * every episode re-boots from the loom document — spec, journal, live thread
 * status — and between episodes nothing runs. But episodes are TURNS in one
 * loom-owned engine session, which buys what an invisible `claude -p` never
 * had: the whole reasoning is a transcript a human can read in the cockpit,
 * steer by replying to (the next episode sees your reply as conversation),
 * and stop like any session. The document stays the memory of record; the
 * transcript is the window onto it.
 *
 * THE CONDUCTOR PROPOSES; THE MACHINE EXECUTES. Each episode must end in one
 * typed decision, applied here through the same code paths as the room's
 * buttons. `accept` is not in its vocabulary at all — the moat holds.
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

/** How long an episode may think before the machine records a non-answer. */
const EPISODE_TIMEOUT_MS = 180_000;

async function gatherBriefing(loom: Loom, client: EngineClient): Promise<string> {
  const threads = await Promise.all(
    loom.threads.map(async (raw) => {
      // Pre-v2 records had no slug; a briefing that prints `undefined` sends
      // the conductor chasing a data artefact instead of the work.
      const t = { ...raw, slug: raw.slug ?? raw.title };
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
  // The LAST JSON object in the reply: the conductor may think out loud
  // first, and the transcript is exactly where that thinking should live.
  const matches = raw.match(/\{[\s\S]*?\}(?=[^{}]*$)/);
  const candidate = matches?.[0] ?? raw.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(candidate) as ConductorMove;
    if (parsed.move === "wait" || parsed.move === "verify") return parsed;
    if (parsed.move === "nudge" && typeof parsed.thread === "string" && typeof parsed.message === "string") return parsed;
    if (parsed.move === "escalate" && typeof parsed.message === "string") return parsed;
    return null;
  } catch {
    return null;
  }
}

/** The conductor's home, created on first need and owned by the loom. */
async function ensureConductorSession(loom: Loom, client: EngineClient): Promise<string> {
  if (loom.conductorSessionId) {
    const alive = await client.session(loom.conductorSessionId).catch(() => null);
    if (alive && alive.session.state !== "archived") return loom.conductorSessionId;
  }
  const created = await client.createSession({
    projectId: loom.projectId,
    title: `Conductor · ${loom.title}`,
    // Local, not worktree: the conductor reads and reasons; it edits nothing,
    // so it gets no checkout of its own to be tempted by.
    envMode: "local",
  });
  const fresh = getLoom(loom.id)!;
  fresh.conductorSessionId = created.session.id;
  saveLoom(fresh);
  appendJournal(loom.id, "machine", `conductor session created: ${created.session.id}`);
  return created.session.id;
}

async function awaitTurn(client: EngineClient, sessionId: string, runId: string): Promise<string | null> {
  const deadline = Date.now() + EPISODE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2_500));
    const snapshot = await client.session(sessionId).catch(() => null);
    const turn = snapshot?.turns.find((t) => t.runId === runId);
    if (!turn) continue;
    if (turn.state === "completed") return turn.resultText ?? "";
    if (turn.state === "failed" || turn.state === "stopped" || turn.state === "discarded" || turn.state === "ambiguous") return null;
  }
  return null;
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

  const sessionId = await ensureConductorSession(loom, client);
  const briefing = await gatherBriefing(loom, client);
  const prompt = [
    "Episodio del conductor. Sos el conductor de este loom de Telar: el agente que STEERS, no el que trabaja.",
    "Tu memoria de registro es el documento de abajo (spec + journal) — el transcript de esta sesión es la ventana del humano sobre tu razonamiento, y si el humano te escribió algo acá arriba, tomalo como steering.",
    briefing,
    "Pensá lo que necesites y cerrá con EXACTAMENTE UN movimiento, como último JSON del mensaje:",
    '- {"move":"wait","reason":"..."} — todo avanza solo; no molestar.',
    '- {"move":"verify","reason":"..."} — los threads parecen terminados (idle + trabajo commiteado); correr la verificación de escritorio limpio.',
    '- {"move":"nudge","thread":"<slug>","message":"...","reason":"..."} — un thread está trabado o se desvió; mandale UN mensaje concreto.',
    '- {"move":"escalate","message":"...","reason":"..."} — esto necesita un humano (contrato imposible, verificación roja repetida, conflicto entre threads).',
    "No existe ningún movimiento que acepte el loom ni cierre issues — eso es del humano, siempre. No edites archivos: proponés, la máquina ejecuta.",
  ].join("\n\n");

  const runId = randomUUID();
  await client.submitTurn(sessionId, { runId, input: prompt });
  const result = await awaitTurn(client, sessionId, runId);
  const decision = result === null ? null : parseDecision(result);
  if (!decision) {
    appendJournal(loomId, "conductor", `episode ended without a parseable decision (turn ${result === null ? "failed/timed out" : "answered off-format"})`);
    saveLoom({ ...getLoom(loomId)!, conductedAt: Date.now() });
    return { decision: { move: "wait", reason: "episode produced no decision" }, applied: false };
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
  saveLoom({ ...getLoom(loomId)!, conductedAt: Date.now() });
  return { decision, applied, ...(detail ? { detail } : {}) };
}
