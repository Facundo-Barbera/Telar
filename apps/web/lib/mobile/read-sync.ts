import crypto from "node:crypto";
import { hasUnreadResult } from "@telar/engine-client";
import type { Delivery, MobileRegistration, SessionSignal } from "./push";

/**
 * READ ON THE MAC, CLEARED ON THE PHONE — WhatsApp-style read sync.
 *
 * THE ENGINE'S UNREAD PAIR IS THE ONLY READ MODEL. A session is unread while
 * `lastTurnSequence > lastReadTurnSequence` (`hasUnreadResult`), and every
 * device moves the second number through the same receipt route. This file
 * adds no read state of its own; it only remembers which sessions this phone
 * was ALERTED about, so it can tell the phone to take those alerts down once
 * the engine says they are dealt with.
 *
 * WHAT "DEALT WITH" MEANS is `readCleared`: no answer left unread AND not
 * blocked. The blocked half matters: a "needs your input" alert names a turn
 * still running, whose previous answer is usually long read, so unread alone
 * would take it down the moment it arrived. Once the request is answered (on
 * any device) and nothing is left unread, the alert is stale either way.
 *
 * ONLY SESSIONS THIS PHONE WAS ALERTED ABOUT. `alerted` is written when APNs
 * accepts an alert, so a silent push is never spent on a session that has no
 * notification on that phone to remove.
 *
 * RELAY v1 PHONES GET NONE OF THIS. v1 is being retired and does not carry the
 * `background` kind; such a phone keeps its alerts until it opens the app,
 * where the launch reconcile (`/api/mobile/read-state`) clears them.
 */

/**
 * AT MOST ONE SILENT PUSH PER PHONE A MINUTE, reads carried to the next one.
 *
 * iOS budgets background pushes (Apple's guidance is "two or three an hour")
 * and drops or delays the excess, so each one should be worth it. Reads come
 * in sweeps — somebody goes down the rail on the Mac opening five sessions —
 * and a minute is long enough to fold a sweep into one push and short enough
 * that the lock screen is tidy before the phone is next picked up. Worst case
 * it is 1,440 a day per phone per Mac; the relay stops background pushes at
 * 4,000 of a handle's 5,000 so alerts always keep the rest.
 */
export const READ_SYNC_INTERVAL_S = 60;
/** Sessions per push. Ids are at most 128 characters (the relay's own id
 *  rule), so sixteen stay well inside APNs' 4 KB; the rest wait a minute. */
export const READ_SYNC_BATCH = 16;
/** A phone with more open alerts than this has stopped reading them; the
 *  oldest are forgotten and left to the launch reconcile. */
export const READ_SYNC_TRACKED = 256;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** What a push record remembers for read sync. Never session content. */
export type ReadSyncState = {
  /** Sessions with an alert APNs accepted and the engine has not yet cleared. */
  alerted: string[];
  /** Cleared on the Mac, not yet told to the phone. */
  pending: string[];
  /** Seconds: when the last silent push was attempted, success or not. */
  sentAt?: number;
};

/** The Mac is done with this session's alerts: nothing unread, nothing waiting. */
export function readCleared(session: Pick<SessionSignal, "activity" | "lastTurnSequence" | "lastReadTurnSequence">): boolean {
  // The engine's own rule, handed only the two fields it reads, so this can
  // never disagree with the dot every other surface draws.
  const { lastTurnSequence, lastReadTurnSequence } = session;
  return session.activity !== "blocked" && !hasUnreadResult({ archived: false, updatedAt: 0, lastTurnSequence, lastReadTurnSequence });
}

/** An alert went out: track it, and drop any pending clear it now supersedes. */
export function noteAlert(state: ReadSyncState, sessionId: string): ReadSyncState {
  if (!ID.test(sessionId)) return state;
  const alerted = [...state.alerted.filter(id => id !== sessionId), sessionId].slice(-READ_SYNC_TRACKED);
  return { ...state, alerted, pending: state.pending.filter(id => id !== sessionId) };
}

/** Move every alerted session the engine has cleared to `pending`. A session
 *  that is gone is forgotten: nothing on the Mac can say it was read. */
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

/** Whether a silent push may go now. */
export function readSyncDue(state: ReadSyncState | undefined, now: number): boolean {
  return !!state?.pending.length && now - (state.sentAt ?? 0) >= READ_SYNC_INTERVAL_S;
}

/** Whether the worker has read-sync work on this pass, even with no alert to send. */
export function readSyncWanted(state: ReadSyncState | undefined, sessions: readonly SessionSignal[], now: number): boolean {
  if (!state) return false;
  return readSyncDue(collectReads(state, sessions), now);
}

/**
 * THE SILENT PUSH: `content-available` and ids, nothing a person reads.
 *
 * `host` is the PHONE's own id for this Mac (`record.hostId`), the same one
 * the alert's `thread-id` begins with, so the phone scopes the clear to this
 * Mac: two Macs can mint the same session id.
 */
export function readSyncDelivery(record: MobileRegistration, sessions: readonly string[]): Delivery {
  return { token: record.token, topic: record.topic, sandbox: record.sandbox, kind: "background",
    collapseId: crypto.createHash("sha256").update(`read:${record.hostId}`).digest("hex"),
    payload: { aps: { "content-available": 1 }, read: { host: record.hostId, sessions: [...sessions] } } };
}

/** At most this many ids per reconcile: a phone asks only about sessions it
 *  still shows alerts for, and more than this is a phone nobody is reading. */
export const READ_STATE_MAX = 64;

/** The ids of a `/api/mobile/read-state?ids=a,b` query, or undefined when it
 *  is malformed or over the bound. */
export function parseReadStateIds(query: string | null): string[] | undefined {
  const ids = [...new Set((query ?? "").split(",").filter(Boolean))];
  if (ids.length === 0 || ids.length > READ_STATE_MAX || !ids.every(id => ID.test(id))) return undefined;
  return ids;
}

/**
 * THE LAUNCH RECONCILE'S ANSWER: which of these sessions' alerts may go.
 *
 * The same `readCleared` rule as the silent push, so the two can never
 * disagree. A session the engine no longer has is cleared too (its alert
 * opens nothing); any other failure leaves it out, because keeping an alert
 * is the safe mistake.
 */
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
