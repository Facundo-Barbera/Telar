/**
 * WHICH SESSIONS ARE ASKING FOR YOUR ATTENTION, AND WHICH ARE NOT.
 *
 * Ported from t3 code's `packages/client-runtime/src/state/threadSettled.ts`.
 * Telar's sidebar used to shelve a row on two clauses it could actually
 * answer — archived, or quiet for three days — and `lib/session-list.ts` said
 * so in its header: "UNREAD and SNOOZED are gone, not faked". The engine now
 * models the state (`Session.settledOverride`, `snoozedUntil`), so this is the
 * missing half.
 *
 * ══ THE THREE-LAYER RULE, IN THE ORDER IT IS EVALUATED ══
 *
 *   1. BLOCKERS BEAT EVERYTHING. A session with a request waiting on a human,
 *      or a turn actually running, stays in the list no matter what anyone
 *      pinned. This is the ordering that makes the whole feature safe: the
 *      worst outcome of a settling system is hiding the one row that needed
 *      you, and putting the blockers first makes that unrepresentable rather
 *      than unlikely.
 *   2. THE EXPLICIT PIN WINS, IN BOTH DIRECTIONS. "settled" shelves a session
 *      the clock would have kept; "active" keeps one the clock would have
 *      shelved. Absent means "let the rule decide" — a third answer, which is
 *      why the engine stores an enum rather than a boolean.
 *   3. THE CLOCK DECIDES THE REST, and only if the reader configured it to.
 *
 * ══ WHAT WE DELIBERATELY DID NOT PORT ══
 *
 * The donor also auto-settles on a merged or closed pull request, and refuses
 * to auto-settle while one is open. Telar reads GitHub per PROJECT and on a
 * thirty-second cache (`github.ts`), with no link from a session to a pull
 * request — so the join does not exist to make, and inventing one from branch
 * names would shelve rows on a guess. The hook is where it would go: see
 * `SettlingOptions`.
 *
 * The donor's `hasQueuedTurnStart` grace window is not ported either, and does
 * not need to be: it exists because its server adopts a message into a session
 * asynchronously, so a just-sent message is briefly invisible. Telar's queue IS
 * the durable record — a submitted turn is in `queue.json` before the response
 * returns — so "is there queued work" is answerable directly.
 */

import type { Session } from "@telar/engine-client";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** The default quiet window, and the one the frozen sidebar already used. */
export const DEFAULT_AUTO_SETTLE_DAYS = 3;

/**
 * What settling needs to know about a session BEYOND its record.
 *
 * Kept as an explicit input rather than read from the session, because none of
 * it is on the session: whether a turn is live and whether a request is parked
 * are answers the cockpit already holds for the row it is looking at, and the
 * sidebar holds for the rest.
 */
export type SessionActivity = {
  /** A turn is queued, claimed or running. */
  working?: boolean;
  /** A request is parked on a human — an approval, or a question. */
  waitingOnYou?: boolean;
  /** When the last turn ended, for the early-wake rule. Absent when none has. */
  lastTurnEndedAt?: number;
  /** The last turn failed. A fresh failure outranks a snooze. */
  failed?: boolean;
  /** When that failure was recorded, so an OLD one does not keep waking a
   *  session somebody snoozed precisely because they had seen it. */
  failedAt?: number;
};

export type SettlingOptions = {
  now: number;
  /** `null` turns the clock off entirely: nothing settles by neglect, only by
   *  decision. */
  autoSettleAfterDays: number | null;
};

/**
 * May this session be shelved right now?
 *
 * DELIBERATELY THE SAME LIST `isSettled` refuses to classify on. Anything the
 * partition will not call settled must also be refused as a settle TARGET, or
 * the button appears to do nothing — which reads as a broken control rather
 * than as a rule.
 */
export function canSettle(activity: SessionActivity): boolean {
  return !activity.waitingOnYou && !activity.working;
}

/**
 * May it be snoozed?
 *
 * A RUNNING SESSION IS SNOOZABLE and a blocked one is not, which is the
 * difference between the two verbs: snoozing only changes what you are shown,
 * so hiding work in progress is a legitimate thing to want. Hiding a question
 * that is waiting on you defeats the question.
 */
export function canSnooze(activity: SessionActivity): boolean {
  return !activity.waitingOnYou;
}

/**
 * Something happened that outranks the snooze.
 *
 * A snooze is "not now", not "never" — so the agent needing you, failing, or
 * finishing the work you were waiting on all cut it short. RAISING A HAND NEVER
 * CLEARS THE STORED SNOOZE: it only stops the session classifying as snoozed,
 * so if the reason goes away the snooze is still there and still counting.
 */
export function raisedHandWhileSnoozed(session: Session, activity: SessionActivity): boolean {
  if (activity.waitingOnYou) return true;
  const snoozedAt = session.snoozedAt;
  /**
   * ONLY A FRESH FAILURE. A session snoozed while ALREADY failed stays snoozed
   * — that snooze was the reader saying "I saw it, not now", and waking it on
   * the same failure would be arguing with them.
   */
  if (activity.failed && (snoozedAt === undefined || (activity.failedAt ?? 0) > snoozedAt)) return true;
  if (snoozedAt !== undefined && activity.lastTurnEndedAt !== undefined && activity.lastTurnEndedAt > snoozedAt) return true;
  return false;
}

/** Hidden until its wake time, unless it has raised its hand. */
export function isSnoozed(session: Session, activity: SessionActivity, options: Pick<SettlingOptions, "now">): boolean {
  const until = session.snoozedUntil;
  if (until === undefined) return false;
  // Malformed data never hides a session. Of the two ways to be wrong, showing
  // a row that should be hidden is the recoverable one.
  if (!Number.isFinite(until)) return false;
  if (until <= options.now) return false;
  return !raisedHandWhileSnoozed(session, activity);
}

/**
 * When a snoozed session woke, or nothing if it never slept or still sleeps.
 *
 * The list's sort is deliberately static — a row does not jump to the top when
 * it wakes, because a list that reorders itself while you read it is not a
 * list. So the WAKE has to carry the signal, and that needs a timestamp.
 */
export function wokeAt(session: Session, activity: SessionActivity, options: Pick<SettlingOptions, "now">): number | undefined {
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

/**
 * Is this session off the list?
 *
 * The whole rule, in the order stated in this file's header. Read it top to
 * bottom: every early return above the clock is a case where the clock has no
 * business having an opinion.
 */
export function isSettled(session: Session, activity: SessionActivity, options: SettlingOptions): boolean {
  // 1. Blockers. Even an explicit settle does not survive a parked request:
  // the reader shelved a session they believed was finished with them.
  if (activity.waitingOnYou || activity.working) return false;
  // An archived session is over. It is shelved by a decision that outranks
  // every pin below, including a `settledOverride` of "active".
  if (session.state === "archived") return true;
  // 2. The pin.
  if (session.settledOverride === "settled") return true;
  if (session.settledOverride === "active") return false;
  // 3. The clock, if the reader wants one.
  if (options.autoSettleAfterDays === null) return false;
  return session.updatedAt < options.now - options.autoSettleAfterDays * DAY_MS;
}

/* ------------------------------------------------------------------ *
 * Snooze presets — the menu behind the clock on a row.
 * ------------------------------------------------------------------ */

export type SnoozePresetId = "hour" | "three-hours" | "evening" | "tomorrow" | "next-week";

export type SnoozePreset = {
  id: SnoozePresetId;
  label: string;
  /** The time column, which COMPLEMENTS the label rather than repeating it:
   *  "Tomorrow" pairs with "9:00 AM", not with "tomorrow 9:00 AM". */
  when: string;
  until: number;
};

const EVENING_HOUR = 18;
const MORNING_HOUR = 9;

function timeLabel(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function atHour(base: Date, hour: number): Date {
  const next = new Date(base);
  next.setHours(hour, 0, 0, 0);
  return next;
}

/**
 * ADVANCED BY CALENDAR DAY, NOT BY 86,400,000.
 *
 * A fixed millisecond offset lands on the wrong local day across a daylight
 * saving transition — a spring-forward day is 23 hours, so 23:30 plus a "day"
 * skips the next day entirely and snoozes something for two.
 */
function addDays(base: Date, days: number): Date {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

/**
 * The choices, resolved against the reader's own clock and locale.
 *
 * "THIS EVENING" DISAPPEARS ONCE IT IS NEARLY EVENING. A snooze that expires in
 * four minutes is not a snooze, and a menu row that sometimes means "an hour"
 * and sometimes means "immediately" is worse than one that is not there.
 */
export function snoozePresets(now: Date): SnoozePreset[] {
  const inAnHour = new Date(now.getTime() + HOUR_MS);
  const inThreeHours = new Date(now.getTime() + 3 * HOUR_MS);
  const presets: SnoozePreset[] = [
    { id: "hour", label: "In 1 hour", when: timeLabel(inAnHour), until: inAnHour.getTime() },
    { id: "three-hours", label: "In 3 hours", when: timeLabel(inThreeHours), until: inThreeHours.getTime() },
  ];

  const evening = atHour(now, EVENING_HOUR);
  if (evening.getTime() - now.getTime() > HOUR_MS) {
    presets.push({ id: "evening", label: "This evening", when: timeLabel(evening), until: evening.getTime() });
  }

  const tomorrow = atHour(addDays(now, 1), MORNING_HOUR);
  presets.push({ id: "tomorrow", label: "Tomorrow", when: timeLabel(tomorrow), until: tomorrow.getTime() });

  // `|| 7` so that on a Monday "next week" means the NEXT Monday, not today.
  const daysUntilMonday = (1 - now.getDay() + 7) % 7 || 7;
  const nextWeek = atHour(addDays(now, daysUntilMonday), MORNING_HOUR);
  presets.push({
    id: "next-week",
    label: "Next week",
    when: `${nextWeek.toLocaleDateString(undefined, { weekday: "short" })} ${timeLabel(nextWeek)}`,
    until: nextWeek.getTime(),
  });

  return presets;
}

/** "2h", "18h", "3d". Minutes round UP so a snooze never reads "0m" while it is
 *  still hiding something. */
export function wakeLabel(snoozedUntil: number, now: number): string {
  const remaining = snoozedUntil - now;
  if (!Number.isFinite(remaining) || remaining <= 0) return "now";
  if (remaining < HOUR_MS) return `${Math.max(1, Math.ceil(remaining / MINUTE_MS))}m`;
  if (remaining < DAY_MS) return `${Math.ceil(remaining / HOUR_MS)}h`;
  return `${Math.ceil(remaining / DAY_MS)}d`;
}
