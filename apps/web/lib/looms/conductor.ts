import { randomUUID } from "node:crypto";
import type { EngineClient } from "@telar/engine-client";
import { appendEvent, getLoom, loomState, readJournal, readSpec, saveLoom, type Loom } from "./store";
import { runLoomVerification } from "./verify";
import { spawnThreads } from "./spawn";

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
  | { move: "respawn"; threads: string[]; reason: string }
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
    if (parsed.move === "respawn" && Array.isArray(parsed.threads) && parsed.threads.every((t) => typeof t === "string")) return parsed;
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
  appendEvent(loom.id, { actor: "machine", kind: "conductor-born", sessionId: created.session.id, detail: `conductor session created: ${created.session.id}` });
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
  // Machine prompt in English; nudge messages and escalations are addressed
  // to the WORK (worker agents, the human reviewing), so they follow the
  // project's language — language is content, never machinery.
  const prompt = [
    "Conductor episode. You are this Telar loom's conductor: the agent that STEERS, never the one that works.",
    "Your memory of record is the document below (spec + journal) — this session's transcript is the human's window onto your reasoning, and if the human wrote to you above, treat it as steering.",
    briefing,
    "Think as much as you need, then close with EXACTLY ONE move, as the last JSON in your message:",
    '- {"move":"wait","reason":"..."} — everything is advancing on its own; do not disturb.',
    '- {"move":"verify","reason":"..."} — the threads look finished (idle + committed work); run the clean-desk verification.',
    '- {"move":"nudge","thread":"<slug>","message":"...","reason":"..."} — a thread is stuck or drifting; send it ONE concrete message.',
    '- {"move":"respawn","threads":["<slug>", ...],"reason":"..."} — threads died without producing work (no commits, no green verification); retire their dead sessions and spawn fresh ones from the same plans. Refused for any thread with a green verification.',
    '- {"move":"escalate","message":"...","reason":"..."} — this needs a human (impossible contract, repeated red verification, conflict between threads).',
    "Write `message` fields in the project's own language (the language of its repo and threads); `reason` may stay in English.",
    "No move exists that accepts the loom or closes issues — that is the human's, always. Do not edit files: you propose, the machine executes.",
  ].join("\n\n");

  const runId = randomUUID();
  await client.submitTurn(sessionId, { runId, input: prompt });
  const result = await awaitTurn(client, sessionId, runId);
  const decision = result === null ? null : parseDecision(result);
  if (!decision) {
    appendEvent(loomId, {
      actor: "conductor",
      kind: "note",
      detail: `episode ended without a parseable decision (turn ${result === null ? "failed/timed out" : "answered off-format"})`,
    });
    saveLoom({ ...getLoom(loomId)!, conductedAt: Date.now() });
    return { decision: { move: "wait", reason: "episode produced no decision" }, applied: false };
  }

  appendEvent(loomId, {
    actor: "conductor",
    kind: decision.move === "escalate" ? "escalation" : "decision",
    move: decision.move,
    ...(decision.move === "nudge" ? { thread: decision.thread } : {}),
    detail: `${decision.move}${decision.move === "nudge" ? `(${decision.thread})` : ""}: ${decision.reason}`,
  });

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
          input: `(nudge from the loom's conductor) ${decision.message}`,
        });
        appendEvent(loomId, {
          actor: "conductor",
          kind: "nudge-delivered",
          thread: thread.slug,
          sessionId: thread.sessionId,
          detail: `nudged ${thread.slug}: ${decision.message.slice(0, 200)}`,
        });
      } else {
        applied = false;
        detail = `no spawned thread "${decision.thread}"`;
      }
      break;
    }
    case "respawn": {
      const fresh = getLoom(loomId)!;
      const refused: string[] = [];
      for (const slug of decision.threads) {
        const thread = fresh.threads.find((t) => t.slug === slug);
        if (!thread) {
          refused.push(`${slug} (unknown)`);
          continue;
        }
        // A green thread carries accepted-grade work; respawning it would
        // reset its branch. The machine refuses rather than trusting the
        // conductor's judgment on the one irreversible move it has.
        if (thread.verification?.ok) {
          refused.push(`${slug} (verified green)`);
          continue;
        }
        if (thread.sessionId) {
          await client.archiveSession(thread.sessionId).catch(() => undefined);
          delete thread.sessionId;
          delete thread.verification;
        }
      }
      saveLoom(fresh);
      await spawnThreads(getLoom(loomId)!, client);
      if (refused.length > 0) {
        applied = decision.threads.length > refused.length;
        detail = `refused: ${refused.join(", ")}`;
        appendEvent(loomId, { actor: "machine", kind: "note", detail: `respawn refused for ${refused.join(", ")}` });
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
