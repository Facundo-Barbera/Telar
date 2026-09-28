import type { SessionActivity } from "./entities";

export type SettleableSession = {
  archived: boolean;
  updatedAt: number;
  settledOverride?: "settled" | "active";
  settledAt?: number;
  snoozedUntil?: number;
  snoozedAt?: number;
  /** The unread pair — see `hasUnreadResult`, and `Session` for what each one
   *  means. Absent on a session that has never produced a result. */
  lastTurnSequence?: number;
  lastReadTurnSequence?: number;
  /** When the newest receipt landed. Only the inactivity baseline reads it;
   *  unread itself is decided on the sequences, never on a clock. */
  readAt?: number;
};

const HOUR_MS = 60 * 60 * 1000;

export type SettlingActivity = {
  /** A turn is queued, claimed or running. */
  working?: boolean;
  /** A request is parked on a human — an approval, or a question. */
  waitingOnYou?: boolean;
  backgroundWork?: boolean;
  /** When the last turn ended, for the early-wake rule. Absent when none has. */
  lastTurnEndedAt?: number;
  /** The last turn failed. A fresh failure outranks a snooze. */
  failed?: boolean;
  failedAt?: number;
};

export type SettlingOptions = {
  now: number;
  /** `null` turns the clock off entirely: nothing settles by neglect, only by
   *  decision. */
  autoSettleAfterHours: number | null;
};

export function settlingActivityOf(session: {
  activity?: SessionActivity;
  lastTurnEndedAt?: number;
  lastTurnFailed?: boolean;
}): SettlingActivity {
  return {
    working: session.activity === "working" || session.activity === "queued",
    waitingOnYou: session.activity === "blocked",
    backgroundWork: session.activity === "monitoring",
    ...(session.lastTurnEndedAt === undefined ? {} : { lastTurnEndedAt: session.lastTurnEndedAt }),
    // A failure is dated by when the turn ended, because that IS when it
    // failed — the engine derives both from the same turn.
    ...(session.lastTurnFailed ? { failed: true, ...(session.lastTurnEndedAt === undefined ? {} : { failedAt: session.lastTurnEndedAt }) } : {}),
  };
}

export function canSettle(activity: SettlingActivity): boolean {
  return !activity.waitingOnYou && !activity.working;
}

export function canSnooze(activity: SettlingActivity): boolean {
  return !activity.waitingOnYou;
}

export function raisedHandWhileSnoozed(session: SettleableSession, activity: SettlingActivity): boolean {
  if (activity.waitingOnYou) return true;
  const snoozedAt = session.snoozedAt;
  if (activity.failed && (snoozedAt === undefined || (activity.failedAt ?? 0) > snoozedAt)) return true;
  if (snoozedAt !== undefined && activity.lastTurnEndedAt !== undefined && activity.lastTurnEndedAt > snoozedAt) return true;
  return false;
}

/** Hidden until its wake time, unless it has raised its hand. */
export function isSnoozed(session: SettleableSession, activity: SettlingActivity, options: Pick<SettlingOptions, "now">): boolean {
  const until = session.snoozedUntil;
  if (until === undefined) return false;
  // Malformed data never hides a session. Of the two ways to be wrong, showing
  // a row that should be hidden is the recoverable one.
  if (!Number.isFinite(until)) return false;
  if (until <= options.now) return false;
  return !raisedHandWhileSnoozed(session, activity);
}

export function wokeAt(session: SettleableSession, activity: SettlingActivity, options: Pick<SettlingOptions, "now">): number | undefined {
  const until = session.snoozedUntil;
  if (until === undefined || !Number.isFinite(until)) return undefined;
  if (raisedHandWhileSnoozed(session, activity)) {
    // The early wake stays authoritative even once the scheduled time passes:
    // reporting the scheduled time then would resurface a signal the reader
    // already dealt with.
    if (session.snoozedAt !== undefined && activity.lastTurnEndedAt !== undefined && activity.lastTurnEndedAt > session.snoozedAt) {
      return activity.lastTurnEndedAt;
    }
    return activity.failedAt ?? session.snoozedAt ?? until;
  }
  return until <= options.now ? until : undefined;
}

export function hasUnreadResult(session: SettleableSession): boolean {
  if (session.lastTurnSequence === undefined) return false;
  return session.lastTurnSequence > (session.lastReadTurnSequence ?? 0);
}

export function idleSince(session: SettleableSession): number {
  const snoozedUntil = Number.isFinite(session.snoozedUntil) ? session.snoozedUntil! : 0;
  return Math.max(session.updatedAt, session.readAt ?? 0, snoozedUntil);
}

export function isStale(session: SettleableSession, options: SettlingOptions): boolean {
  if (options.autoSettleAfterHours === null) return false;
  return idleSince(session) < options.now - options.autoSettleAfterHours * HOUR_MS;
}

export function isSettled(session: SettleableSession, activity: SettlingActivity, options: SettlingOptions): boolean {
  if (activity.waitingOnYou || activity.working) return false;
  // An archived session is over. It is shelved by a decision that outranks
  // every pin below, including a `settledOverride` of "active".
  if (session.archived) return true;
  if (session.settledOverride === "settled") return true;
  if (session.settledOverride === "active") return false;
  if (session.snoozedUntil !== undefined && Number.isFinite(session.snoozedUntil) && session.snoozedUntil > options.now) return false;
  if (hasUnreadResult(session)) return false;
  if (activity.backgroundWork) return false;
  // 4. The clock, if the reader wants one.
  return isStale(session, options);
}

export function isShelved(
  session: SettleableSession & { draft?: boolean },
  activity: SettlingActivity,
  options: SettlingOptions,
): boolean {
  if (session.draft && !session.archived && session.settledOverride !== "settled") return false;
  return isSettled(session, activity, options);
}
