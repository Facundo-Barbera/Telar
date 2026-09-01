import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Session, SessionActivity } from "@telar/engine-client";

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
export const LINTEL_SYNC_MS = 30_000;
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

async function post(pathname: string, body: unknown, token: string): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${LINTEL_PORT}${pathname}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(1_000),
    });
  } catch {
    // Lintel isn't here. The contract: silently do nothing.
  }
}

async function remove(id: string, token: string): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${LINTEL_PORT}/v1/agents/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(1_000),
    });
  } catch {
    // Same silence.
  }
}

/**
 * The sync loop. `TELAR_LINTEL=0` is the kill switch; otherwise presence of
 * the token file IS the opt-in — Lintel is a personal tool, and installing
 * it is the gesture that asks for this.
 */
export function startLintelSync(
  read: () => { sessions: Session[]; projects: Array<{ id: string; name: string }> },
  options: { intervalMs?: number; tokenPath?: string } = {},
): { stop: () => void } {
  if (process.env.TELAR_LINTEL === "0") return { stop: () => {} };
  let previous = new Map<string, SessionActivity>();
  let inFlight = false;

  const pass = async (): Promise<void> => {
    if (inFlight) return;
    const token = readLintelToken(options.tokenPath ?? lintelTokenPath());
    if (!token) return;
    inFlight = true;
    try {
      const { sessions, projects } = read();
      const projectNames = new Map(projects.map((project) => [project.id, project.name]));
      const { plan, next } = lintelPlan(sessions, projectNames, previous);
      previous = next;
      for (const agent of plan.agents) await post("/v1/agents", agent, token);
      for (const banner of plan.banners) await post("/v1/banner", banner, token);
      for (const id of plan.removals) await remove(id, token);
    } catch {
      // Reading state failed this pass; the next one will try again.
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => void pass(), options.intervalMs ?? LINTEL_SYNC_MS);
  timer.unref();
  void pass();
  return { stop: () => clearInterval(timer) };
}
