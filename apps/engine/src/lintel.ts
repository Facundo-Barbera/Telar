import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { EngineEvent, Session, SessionActivity } from "@telar/engine-client";

/**
 * THE LINTEL BRIDGE — Telar sessions as chips in the notch.
 *
 * Lintel (the user's notch app) exposes a loopback HTTP API on :45814 with a
 * bearer token at ~/Library/Application Support/Lintel/api-token, and its
 * contract (lintel/API.md) is explicit: Lintel is a DISPLAY, not a broker.
 * A missing token file or any connection failure means "Lintel isn't here" —
 * silently do nothing, never block, never retry, never error. Timeout ~1s.
 *
 * The mapping: every session that is working / blocked / monitoring is a
 * Lintel "agent" (its live-activity chip). Lintel expires active agents
 * 120s after their last upsert — a deliberate anti-ghost design — so the
 * sync RE-POSTS every live session on each pass; the 30s cadence is the
 * heartbeat. Transitions to done/failed are posted once and Lintel clears
 * them after 60s on its own. Blocked additionally fires a banner, because
 * "waiting on you" is the one state that is a request addressed to a person.
 */

export const LINTEL_PORT = Number(process.env.LINTEL_PORT) || 45814;
/** 5s: fast enough that a mirrored chat reads live, and every pass re-upserts
 *  the agents, which is the heartbeat Lintel's 120s TTL wants. */
export const LINTEL_SYNC_MS = 5_000;
/** Lintel truncates chat messages at 4000 chars; cut before sending. */
export const LINTEL_MESSAGE_MAX = 4_000;
/** On first sight of a session, mirror at most this many recent messages —
 *  a fresh session's opening prompt makes it in (it IS the recent tail), a
 *  months-old transcript doesn't dump. */
export const LINTEL_BOOTSTRAP_MESSAGES = 20;
/** Clicking a Lintel banner launches the app with this bundle id. */
const TELAR_BUNDLE_ID = "ai.ozom.telar.desktop";

export function lintelTokenPath(home: string = os.homedir()): string {
  return path.join(home, "Library", "Application Support", "Lintel", "api-token");
}

export function readLintelToken(tokenPath: string = lintelTokenPath()): string | undefined {
  try {
    const token = fs.readFileSync(tokenPath, "utf8").trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

/** One agent upsert body, one banner body — Lintel's own field names. */
export type LintelAgent = { id: string; name: string; status: "running" | "done" | "error"; detail?: string };
export type LintelBanner = { title: string; body: string; app: string; bundleID: string };

export type LintelPlan = {
  agents: LintelAgent[];
  banners: LintelBanner[];
  /** Agent ids to DELETE — sessions that vanished mid-flight. */
  removals: string[];
};

const LIVE: ReadonlySet<SessionActivity> = new Set(["working", "blocked", "monitoring"]);

function chip(session: Session, projectName: string | undefined, status: LintelAgent["status"], detail: string): LintelAgent {
  return {
    id: session.id,
    // Lintel truncates banner names at 24 chars itself; the chip just wraps.
    name: session.title || "Untitled session",
    status,
    detail: projectName ? `${detail} · ${projectName}` : detail,
  };
}

/**
 * PURE: what to tell Lintel, given the sessions now and the activities the
 * previous pass saw. Exported for tests; the sync loop just executes it.
 */
export function lintelPlan(
  sessions: Session[],
  projectNames: Map<string, string>,
  previous: Map<string, SessionActivity>,
): { plan: LintelPlan; next: Map<string, SessionActivity> } {
  const next = new Map<string, SessionActivity>();
  const plan: LintelPlan = { agents: [], banners: [], removals: [] };

  for (const session of sessions) {
    const activity = session.activity ?? "idle";
    const projectName = session.projectId ? projectNames.get(session.projectId) : undefined;
    const before = previous.get(session.id);
    if (LIVE.has(activity)) {
      next.set(session.id, activity);
      // Blocked wears the red dot: it is the one chip asking for a person.
      const status = activity === "blocked" ? "error" : "running";
      const detail = activity === "blocked" ? "Waiting on you" : activity === "working" ? "Working" : "Monitoring";
      plan.agents.push(chip(session, projectName, status, detail));
      if (activity === "blocked" && before !== "blocked") {
        plan.banners.push({
          title: "Waiting on you",
          body: session.title || "A session needs a decision.",
          app: "Telar",
          bundleID: TELAR_BUNDLE_ID,
        });
      }
      continue;
    }
    if (before !== undefined && LIVE.has(before)) {
      // Ended since last pass: one terminal upsert, Lintel clears it in 60s
      // and fires its own "done"/"failed" banner on the transition.
      const failed = session.lastTurnFailed === true;
      plan.agents.push(chip(session, projectName, failed ? "error" : "done", failed ? "Failed" : "Done"));
    }
  }
  // A session the previous pass knew and this list no longer contains was
  // deleted outright — its chip must not linger for the TTL.
  for (const id of previous.keys()) {
    if (!next.has(id) && !sessions.some((session) => session.id === id)) plan.removals.push(id);
  }
  return { plan, next };
}

/**
 * PURE: the chat lines a batch of journal events mirrors out to Lintel.
 *
 * `turn.accepted` carries the human's prompt; a completed `assistant_message`
 * item carries the reply; a completed `user_message` item is a steered prompt
 * landing inside a run. `skipRunIds`/`skipTexts` are the NO-ECHO rule: a
 * message that arrived FROM Lintel's chat window is already on its screen,
 * and mirroring it back would double it.
 */
export function mirrorMessages(
  events: EngineEvent[],
  skip: { runIds: ReadonlySet<string>; texts: ReadonlySet<string> },
): Array<{ role: "user" | "assistant"; text: string }> {
  const messages: Array<{ role: "user" | "assistant"; text: string }> = [];
  const clip = (text: string): string => (text.length > LINTEL_MESSAGE_MAX ? text.slice(0, LINTEL_MESSAGE_MAX) : text);
  for (const event of events) {
    if (event.type === "turn.accepted") {
      if (event.replayed || skip.runIds.has(event.turn.runId) || skip.texts.has(event.turn.input)) continue;
      if (event.turn.input.trim().length > 0) messages.push({ role: "user", text: clip(event.turn.input) });
      continue;
    }
    if (event.type !== "item.completed") continue;
    const detail = event.item.detail;
    if (detail.type === "assistant_message" && detail.text.trim().length > 0) {
      messages.push({ role: "assistant", text: clip(detail.text) });
    } else if (detail.type === "user_message" && detail.text.trim().length > 0 && !skip.texts.has(detail.text)) {
      messages.push({ role: "user", text: clip(detail.text) });
    }
  }
  return messages;
}

/**
 * The inbound half: a loopback listener Lintel calls when the human types in
 * its floating chat window. Bearer-checked with a per-boot secret, answers
 * 2xx IMMEDIATELY and processes async, dedupes on messageId (retries reuse
 * it) — all per the contract.
 */
export function startLintelCallbackServer(
  onMessage: (agentId: string, text: string) => void,
): Promise<{ url: string; token: string; close: () => void }> {
  const token = crypto.randomBytes(32).toString("hex");
  const seen = new Set<string>();
  const server = http.createServer((request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end();
      return;
    }
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
      if (body.length > 64_000) request.destroy();
    });
    request.on("end", () => {
      // 2xx first, work after — Lintel must never wait on the injection.
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
      try {
        const payload = JSON.parse(body) as { type?: unknown; agentId?: unknown; messageId?: unknown; text?: unknown };
        if (payload.type !== "user_message") return;
        if (typeof payload.agentId !== "string" || typeof payload.text !== "string" || payload.text.trim().length === 0) return;
        const messageId = typeof payload.messageId === "string" ? payload.messageId : crypto.randomUUID();
        if (seen.has(messageId)) return;
        seen.add(messageId);
        if (seen.size > 1_000) seen.delete(seen.values().next().value!);
        queueMicrotask(() => onMessage(payload.agentId as string, payload.text as string));
      } catch {
        // A malformed body is Lintel's bug, not a reason to crash the engine.
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.unref();
      resolve({ url: `http://127.0.0.1:${port}/lintel`, token, close: () => server.close() });
    });
  });
}

/** Returns the HTTP status, or undefined when Lintel isn't here — the one
 *  status the sync inspects is the /messages 404 (agent expired or Lintel
 *  restarted), which triggers a re-registration. */
async function post(pathname: string, body: unknown, token: string, port: number): Promise<number | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(1_000),
    });
    return response.status;
  } catch {
    // Lintel isn't here. The contract: silently do nothing.
    return undefined;
  }
}

/** Which agents Lintel already knows — the anti-duplication check: a
 *  bootstrap slice is only for an agent Lintel has never seen. Failure reads
 *  as "none known", which is also the state where posting fails anyway. */
async function knownAgents(token: string, port: number): Promise<Set<string>> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/agents`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(1_000),
    });
    const body = (await response.json()) as { agents?: Array<{ id?: unknown }> };
    return new Set((body.agents ?? []).map((agent) => agent.id).filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set();
  }
}

async function remove(id: string, token: string, port: number): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${port}/v1/agents/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(1_000),
    });
  } catch {
    // Same silence.
  }
}

export type LintelHooks = {
  liveSessions: () => { sessions: Session[]; projects: Array<{ id: string; name: string }> };
  /** The session's journal after an event id — the mirroring source. */
  readEvents: (sessionId: string, after: number) => EngineEvent[];
  /** Inject a prompt exactly as the cockpit's composer would. */
  submitTurn: (sessionId: string, input: { runId: string; input: string }) => void;
};

/**
 * The adapter. `TELAR_LINTEL=0` is the kill switch; otherwise presence of
 * the token file IS the opt-in — Lintel is a personal tool, and installing
 * it is the gesture that asks for this. Everything here is fire-and-forget
 * per the contract: Telar behaves identically with Lintel absent.
 */
export function startLintelSync(
  hooks: LintelHooks,
  options: { intervalMs?: number; tokenPath?: string; port?: number } = {},
): { stop: () => void } {
  if (process.env.TELAR_LINTEL === "0") return { stop: () => {} };
  const port = options.port ?? LINTEL_PORT;
  let previous = new Map<string, SessionActivity>();
  /** Journal cursor per session, set to the CURRENT tail when a session first
   *  goes live — "send as they happen", not a history dump. */
  const cursors = new Map<string, number>();
  /** The no-echo ledger: turns this adapter injected from Lintel's window. */
  const injectedRuns = new Set<string>();
  const injectedTexts = new Set<string>();
  let callback: { url: string; token: string; close: () => void } | undefined;
  let callbackStarting = false;
  let stopped = false;
  let inFlight = false;

  const inject = (sessionId: string, text: string): void => {
    try {
      const runId = "run_" + crypto.randomUUID().replaceAll("-", "");
      injectedRuns.add(runId);
      injectedTexts.add(text);
      if (injectedTexts.size > 200) injectedTexts.delete(injectedTexts.values().next().value!);
      hooks.submitTurn(sessionId, { runId, input: text });
    } catch {
      // A vanished session or a refused turn is not Lintel's problem — and
      // the contract forbids surfacing it there.
    }
  };

  const pass = async (): Promise<void> => {
    if (inFlight || stopped) return;
    const token = readLintelToken(options.tokenPath ?? lintelTokenPath());
    if (!token) return;
    if (!callback && !callbackStarting) {
      // Lazily, once: the listener only exists so Lintel can call back, so
      // it starts the first time Lintel is actually there.
      callbackStarting = true;
      callback = await startLintelCallbackServer(inject);
      if (stopped) callback.close();
    }
    inFlight = true;
    try {
      const { sessions, projects } = hooks.liveSessions();
      const projectNames = new Map(projects.map((project) => [project.id, project.name]));
      const { plan, next } = lintelPlan(sessions, projectNames, previous);
      previous = next;
      // Which chips Lintel already holds — read BEFORE this pass's upserts,
      // and only when a first-sight session makes the answer matter. An
      // adapter restart must not re-mirror a chat Lintel kept (its TTL
      // outlives an engine restart; that duplication shipped once).
      const anyFirstSight = [...next.keys(), ...plan.agents.map((agent) => agent.id)].some((id) => !cursors.has(id));
      const alreadyKnown = anyFirstSight ? await knownAgents(token, port) : new Set<string>();
      /** The full registration per agent id — what a 404 re-POSTs. */
      const registrations = new Map<string, unknown>();
      for (const agent of plan.agents) {
        const registration = callback ? { ...agent, callbackURL: callback.url, callbackToken: callback.token } : agent;
        registrations.set(agent.id, registration);
        await post("/v1/agents", registration, token, port);
      }
      for (const banner of plan.banners) await post("/v1/banner", banner, token, port);
      for (const id of plan.removals) {
        await remove(id, token, port);
        cursors.delete(id);
      }
      // Mirror every session with a chip this pass: the live ones, AND the
      // ones that just ended — a fast turn's reply lands between passes, and
      // skipping ended sessions dropped it (found live: a chip with an empty
      // chat beside a finished session).
      const mirrorIds = new Set<string>([...next.keys(), ...plan.agents.map((agent) => agent.id)]);
      for (const id of mirrorIds) {
        const first = !cursors.has(id);
        const events = hooks.readEvents(id, cursors.get(id) ?? 0);
        const tail = events.at(-1)?.id;
        if (tail !== undefined) cursors.set(id, tail);
        let messages = mirrorMessages(events, { runIds: injectedRuns, texts: injectedTexts });
        // First sight: a capped recent slice, not silence — a NEW session's
        // whole story is its opening prompt, and skipping it left short
        // sessions with an empty chat forever. The cap keeps an old
        // transcript from dumping — and an agent Lintel ALREADY knows gets
        // no slice at all: its chat has the story, and re-sending it is the
        // duplication an adapter restart once caused.
        if (first) messages = alreadyKnown.has(id) ? [] : messages.slice(-LINTEL_BOOTSTRAP_MESSAGES);
        for (const message of messages) {
          const status = await post(`/v1/agents/${encodeURIComponent(id)}/messages`, message, token, port);
          if (status === 404) {
            // Lintel restarted or the agent expired between upsert and
            // message: re-register in full and retry ONCE — the contract's
            // self-heal, never a loop.
            const registration = registrations.get(id);
            if (registration !== undefined) {
              await post("/v1/agents", registration, token, port);
              await post(`/v1/agents/${encodeURIComponent(id)}/messages`, message, token, port);
            }
          }
        }
      }
      for (const id of [...cursors.keys()]) if (!mirrorIds.has(id)) cursors.delete(id);
    } catch {
      // Reading state failed this pass; the next one will try again.
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => void pass(), options.intervalMs ?? LINTEL_SYNC_MS);
  timer.unref();
  void pass();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      callback?.close();
    },
  };
}
