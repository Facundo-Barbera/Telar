/**
 * THE ONE SANCTIONED CLOCK READ — docs/spool-definition.md §3.2 AS AMENDED,
 * 2026-08-16 (the workbench pass).
 *
 * The amendment, quoted: "A renderer may now read the clock for exactly one
 * purpose: to know which day is today so it can draw the user's own dates in
 * the right place and say, quietly, 'you pinned this to Tuesday — it's still
 * here.'" That purpose lives HERE and nowhere else: `todayDay()` is the only
 * place a Spool renderer touches the clock, and the idiom suite asserts both
 * that this file carries this citation and that the renderers importing it
 * contain no clock read of their own.
 *
 * What stays banned, forever, per the same amendment: countdowns, overdue-red,
 * badges, reordering the user's attention because a clock ticked, and any date
 * the user did not state. Everything else in this file is PURE date arithmetic
 * over the user's own stored `YYYY-MM-DD` strings — quoting, never computing
 * urgency. Two days compare as plain strings; nothing here derives an age, a
 * distance-to-deadline or an order of importance.
 */

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const pad = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DD` → its three numbers. Callers own the shape guarantee — the
 *  store refuses any other spelling before a renderer ever sees one. */
function parts(day: string): [number, number, number] {
  const [y, m, d] = day.split("-").map(Number);
  return [y ?? 1970, m ?? 1, d ?? 1];
}

/** A stored day as a UTC instant — construction from the user's own numbers,
 *  never from the clock. UTC so arithmetic cannot slip across a DST edge. */
function toUTC(day: string): Date {
  const [y, m, d] = parts(day);
  return new Date(Date.UTC(y, m - 1, d));
}

function fromUTC(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/**
 * WHICH DAY IS TODAY — the sanctioned read, in the user's own timezone,
 * because "today" on a calendar means the day the human is living in.
 * §3.2 as amended: this exists so the grid can place the user's dates and
 * the room can say "you pinned this to today" — never to alarm.
 */
export function todayDay(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** "Tue 19 Aug" — a PURE FORMAT of a day the user stated. Quoting their own
 *  date in friendlier clothes, never a computation of urgency. */
export function formatDay(day: string): string {
  const date = toUTC(day);
  return `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

/** "August 2026" — the grid's own caption. */
export function monthLabel(day: string): string {
  const [y, m] = parts(day);
  return `${MONTHS_LONG[m - 1]} ${y}`;
}

export function addDays(day: string, n: number): string {
  const date = toUTC(day);
  date.setUTCDate(date.getUTCDate() + n);
  return fromUTC(date);
}

export function addMonths(day: string, n: number): string {
  const [y, m] = parts(day);
  // Clamped to the 1st before shifting, so "31 Jan + 1 month" cannot skip.
  return fromUTC(new Date(Date.UTC(y, m - 1 + n, 1)));
}

/** The Monday-first week containing `day`, as seven `YYYY-MM-DD` strings. */
export function weekOf(day: string): string[] {
  const date = toUTC(day);
  const back = (date.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  const monday = addDays(day, -back);
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/** The Monday-first weeks covering `day`'s month — a month grid's rows. Days
 *  outside the month ride along; the renderer dims them rather than lying
 *  about where a week starts. */
export function monthGridOf(day: string): string[][] {
  const [y, m] = parts(day);
  const first = fromUTC(new Date(Date.UTC(y, m - 1, 1)));
  const last = fromUTC(new Date(Date.UTC(y, m, 0)));
  const weeks: string[][] = [];
  for (let cursor = weekOf(first)[0]!; cursor <= last; cursor = addDays(cursor, 7)) {
    weeks.push(weekOf(cursor));
  }
  return weeks;
}

/** Whether a day sits in the same month as `anchor` — the dimming test. */
export function sameMonth(day: string, anchor: string): boolean {
  return day.slice(0, 7) === anchor.slice(0, 7);
}
