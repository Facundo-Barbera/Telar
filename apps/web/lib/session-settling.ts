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

/**
 * WHAT SETTLING ENDED, AS THE SETTLED BANNER SAYS IT — issue #883. Settling
 * closes the conversation's terminals and stops its background tasks, and the
 * person who pressed Settle is told what that took. `undefined` when it ended
 * nothing, or the engine did not say.
 */
const terminalsWord = (count: number) => `${count} terminal${count === 1 ? "" : "s"}`;

/**
 * WHAT SETTLE WILL CLOSE, SAID BEFORE THE PRESS — issue #883. "closes 2
 * terminals" beside Settle, from every place it is offered; nothing at all
 * when there are none, because a settle that ends nothing has nothing to warn.
 */
export function settleClosesText(terminals: number | undefined): string | undefined {
  return terminals && terminals > 0 ? `closes ${terminalsWord(terminals)}` : undefined;
}

/** A settled row's count, explained on hover. */
export function settledTerminalsHint(terminals: number): string {
  return `${terminalsWord(terminals)} still open in this settled conversation, shells you opened included`;
}

/**
 * WHY A SETTLED ROW'S TERMINALS ARE GONE, when Telar closed them rather than
 * the person — `Session.terminalsClosed`. Only while it describes this stay on
 * the shelf: any later work or decision moves `updatedAt` past it.
 */
export function terminalsClosedHint(
  session: { updatedAt: number; terminalsClosed?: { at: number; terminals: number; reason: "grace" | "limit" } },
): string | undefined {
  const closed = session.terminalsClosed;
  if (!closed || closed.at < session.updatedAt) return undefined;
  return closed.reason === "limit"
    ? `Telar closed its ${terminalsWord(closed.terminals)}: settled conversations had more open than the limit in Settings, and this one was settled longest ago`
    : `Telar closed its ${terminalsWord(closed.terminals)} 30 minutes after it settled on its own`;
}

export function settleEndedText(ended: { terminals: number; backgroundTasks: number } | undefined): string | undefined {
  if (!ended) return undefined;
  const parts = [
    ...(ended.terminals > 0 ? [`${ended.terminals} terminal${ended.terminals === 1 ? "" : "s"}`] : []),
    ...(ended.backgroundTasks > 0 ? [`${ended.backgroundTasks} background task${ended.backgroundTasks === 1 ? "" : "s"}`] : []),
  ];
  return parts.length ? `Settling ended ${parts.join(" and ")}.` : undefined;
}
