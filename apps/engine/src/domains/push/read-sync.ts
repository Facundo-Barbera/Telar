import crypto from "node:crypto";
import { hasUnreadResult } from "@telar/engine-client";
import type { Delivery, MobileRegistration, SessionSignal } from "./push";

export const READ_SYNC_INTERVAL_S = 60;
export const READ_SYNC_BATCH = 16;
const READ_SYNC_TRACKED = 256;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

export type ReadSyncState = {
  alerted: string[];
  pending: string[];
  sentAt?: number;
};

export function readCleared(session: Pick<SessionSignal, "activity" | "lastTurnSequence" | "lastReadTurnSequence">): boolean {
  const { lastTurnSequence, lastReadTurnSequence } = session;
  return session.activity !== "blocked" && !hasUnreadResult({ archived: false, updatedAt: 0, lastTurnSequence, lastReadTurnSequence });
}

export function noteAlert(state: ReadSyncState, sessionId: string): ReadSyncState {
  if (!ID.test(sessionId)) return state;
  const alerted = [...state.alerted.filter(id => id !== sessionId), sessionId].slice(-READ_SYNC_TRACKED);
  return { ...state, alerted, pending: state.pending.filter(id => id !== sessionId) };
}

export function collectReads(state: ReadSyncState, sessions: readonly SessionSignal[]): ReadSyncState {
  const byId = new Map(sessions.map(s => [s.id, s]));
  const cleared = state.alerted.filter(id => byId.has(id) && readCleared(byId.get(id)!));
  if (!cleared.length && state.alerted.every(id => byId.has(id))) return state;
  return {
    ...state,
    alerted: state.alerted.filter(id => byId.has(id) && !cleared.includes(id)),
    pending: [...state.pending, ...cleared.filter(id => !state.pending.includes(id))].slice(-READ_SYNC_TRACKED),
  };
}

export function readSyncDue(state: ReadSyncState | undefined, now: number): boolean {
  return !!state?.pending.length && now - (state.sentAt ?? 0) >= READ_SYNC_INTERVAL_S;
}

export function readSyncWanted(state: ReadSyncState | undefined, sessions: readonly SessionSignal[], now: number): boolean {
  if (!state) return false;
  return readSyncDue(collectReads(state, sessions), now);
}

export function readSyncDelivery(record: MobileRegistration, sessions: readonly string[]): Delivery {
  return { token: record.token, topic: record.topic, sandbox: record.sandbox, kind: "background",
    collapseId: crypto.createHash("sha256").update(`read:${record.hostId}`).digest("hex"),
    payload: { aps: { "content-available": 1 }, read: { host: record.hostId, sessions: [...sessions] } } };
}

export const READ_STATE_MAX = 64;

export function parseReadStateIds(query: string | null): string[] | undefined {
  const ids = [...new Set((query ?? "").split(",").filter(Boolean))];
  if (ids.length === 0 || ids.length > READ_STATE_MAX || !ids.every(id => ID.test(id))) return undefined;
  return ids;
}

export async function clearedSessions(
  ids: readonly string[],
  read: (id: string) => Promise<Pick<SessionSignal, "activity" | "lastTurnSequence" | "lastReadTurnSequence"> | undefined>,
): Promise<string[]> {
  const answers = await Promise.all(ids.map(async id => {
    try { const session = await read(id); return session === undefined || readCleared(session) ? id : undefined; }
    catch { return undefined; }
  }));
  return answers.filter((id): id is string => id !== undefined);
}
