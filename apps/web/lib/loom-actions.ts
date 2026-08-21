"use client";

/**
 * THE VERBS. Every write this vertical can make, spelled once.
 *
 * Each returns `{ ok }` plus the engine's own sentence when it refused, because
 * the store's error vocabulary preserves the message and a surface that
 * replaced it with "something went wrong" would throw away the only useful part
 * of the answer. Nothing here throws: a failed write leaves the last good
 * snapshot on screen and says why, which is the same posture the reads take.
 */

export type LoomActionResult<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

async function send<T>(path: string, init: RequestInit): Promise<LoomActionResult<T>> {
  try {
    const res = await fetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    });
    // A 202 carries a body too — the run record — so it is read like any other.
    const body = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    if (!res.ok) {
      const message =
        (body && typeof body === "object" && "message" in body && typeof body.message === "string" && body.message) ||
        (body && typeof body === "object" && "error" in body && typeof body.error === "string" && body.error) ||
        `The engine answered ${res.status}.`;
      return { ok: false, error: message };
    }
    return { ok: true, data: body as T };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "The engine could not be reached." };
  }
}

const post = <T>(path: string, body?: unknown): Promise<LoomActionResult<T>> =>
  send<T>(path, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

/** Answer a loom that escalated past its ladder. The answer is prose; the
 *  orchestrator reads it, the engine does not interpret it. */
export const answerLoom = <T>(loomId: string, answer: string) =>
  post<T>(`/api/looms/${encodeURIComponent(loomId)}/answer`, { answer });

export const cancelLoom = <T>(loomId: string) => post<T>(`/api/looms/${encodeURIComponent(loomId)}/cancel`);

export const dispatchLoom = <T>(input: { projectId: string; item: string; title?: string; brief?: string }) =>
  post<T>("/api/looms/dispatch", input);

/** Arm or disarm the sentinel. Idle is free, so `running: true` costs one
 *  command per interval and no model at all. */
export const setLoomWatch = <T>(projectId: string, running: boolean) =>
  post<T>("/api/looms/watch", { projectId, running });

/** 202 — the run is detached and its progress arrives through `/api/looms/work`. */
export const tickLoom = <T>(projectId: string) => post<T>("/api/looms/tick", { projectId });

/**
 * THE TRUST SURFACE. A real tick that dispatches nothing: what it would do
 * right now, and — the part that matters — what it noticed that you did not
 * say. It costs almost nothing and happens before anything is dispatched.
 */
export const dryRunLoom = <T>(projectId: string) => post<T>("/api/looms/dry-run", { projectId });

export const suggestLoomProgram = <T>(projectId: string) => post<T>("/api/looms/program/suggest", { projectId });

/** The whole artifact, round-tripped by the engine's own parser and renderer. */
export const saveLoomProgram = <T>(projectId: string, markdown: string) =>
  send<T>("/api/looms/program", { method: "PUT", body: JSON.stringify({ projectId, markdown }) });

/**
 * THE ORCHESTRATOR'S SESSION — create or return, never a second one.
 *
 * The centre of `/looms/[projectId]` is a STOCK Telar session and this is the
 * only thing the loom surface needs in order to point at one. It is called
 * lazily, when a cockpit is actually opened for a project whose summary has no
 * `orchestratorSessionId` — not from the deck, which would mint a session for
 * every project a person merely glanced at.
 *
 * `created: true` means it has been seeded with a setup prompt and is already
 * working, which is the natural opening state for a project with no Program:
 * the conversation IS the setup, per §12.
 */
export const ensureLoomSession = (projectId: string) =>
  post<{ sessionId: string; created: boolean }>("/api/looms/session", { projectId });
