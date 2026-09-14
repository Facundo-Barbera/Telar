/**
 * WHICH SESSIONS ARE ASKING FOR YOUR ATTENTION, AND WHICH ARE NOT.
 *
 * THE RULE ITSELF MOVED TO THE PROTOCOL (#457) and is re-exported here, so the
 * thirty-odd imports of this module — and their mental model of where the
 * sidebar's rules live — did not have to change with it.
 *
 * WHY IT MOVED. `GET /v2/sessions/live` now answers only the UNSETTLED rows by
 * default: 7 of 291 on the owner's store, instead of folding and serialising all
 * 291 every three seconds per connected cockpit. That means the ENGINE decides
 * "settled" on the way out, and an engine that disagreed with this module would
 * produce an invisible session — a row the engine dropped and the rail would
 * have drawn, with nothing on either side to notice it was missing. One module,
 * imported by both, makes that unrepresentable rather than unlikely. See
 * `@telar/engine-client`'s `protocol/settling.ts` for the rule and its argument.
 *
 * WHAT STAYED HERE is the snooze MENU: the presets and the wake label, which
 * read a locale and a wall clock and belong to the surface that draws them. The
 * engine has no menu.
 */
export {
  canSettle,
  canSnooze,
  hasUnreadResult,
  isSettled,
  isShelved,
  isSnoozed,
  isStale,
  raisedHandWhileSnoozed,
  settlingActivityOf,
  wokeAt,
  type SettleableSession,
  type SettlingActivity,
  type SettlingOptions,
} from "@telar/engine-client";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

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
