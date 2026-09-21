/**
 * WHEN A SCHEDULE NEXT FIRES, AND WHETHER A DUE ONE STILL SHOULD — issue #543.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * PURE, AND IMPORTING NOTHING. Every decision this feature makes that is hard
 * to get right is local-calendar arithmetic, and none of it needs a store, a
 * clock or a daemon. So it lives here, where a test can drive it with two
 * numbers, and `state.ts` is left holding only the bookkeeping.
 *
 * THE SWEEP IS DEADLINE-DRIVEN, NEVER CATCH-UP. It asks "which rows are due?",
 * not "how many ticks did I miss?" — so a gap of five seconds and a gap of five
 * days take the identical path. That is what makes this independent of whether
 * `setInterval` is suspend-aware on any given platform: a late tick changes
 * WHEN a due row is noticed, never WHAT happens to it.
 * ────────────────────────────────────────────────────────────────────────────
 */

/**
 * HOW LATE A FIXED-TIME RUN MAY BE AND STILL HAPPEN — issue #543.
 *
 * SHORT ENOUGH that a run missed by a laptop lid closing for a moment still
 * fires; LONG ENOUGH to cover a sweep interval plus a slow engine start. Past
 * it, the run is SKIPPED rather than fired late, which is the issue's whole
 * "missed runs re-aimed, not fired late" clause: a 09:00 digest arriving at
 * 16:00 is not a late digest, it is a wrong one.
 *
 * A PRODUCT JUDGEMENT, NOT A MEASUREMENT, and said so rather than dressed up.
 * Nobody has asked the owner what "long-missed" means to him; five minutes is
 * the proposal, and it is one named constant precisely so changing his mind
 * costs one line.
 *
 * INTERVAL ROWS DO NOT USE IT. "Every hour" has no wall-clock appointment to be
 * late for — the next hour is simply the next hour — so lateness there is
 * answered by advancing past `now`, below.
 */
export const SCHEDULE_GRACE_MS = 5 * 60_000;

/** Every minute of the week a fixed-time rule may name. `weekdays` is empty for
 *  "every day"; 0 is Sunday, matching `Date.prototype.getDay`. */
export type ScheduleRule =
  | { kind: "interval"; everyMs: number }
  | { kind: "fixed"; hour: number; minute: number; weekdays: readonly number[] };

/** The smallest interval a row may carry. The issue's floor, and the reason the
 *  sweep runs at 30 s rather than 60: a sweep at the floor would silently make
 *  the floor twice what it says. */
export const MIN_SCHEDULE_INTERVAL_MS = 60_000;

/**
 * The parts of an instant as they read on a wall clock in `zone`.
 *
 * `Intl.DateTimeFormat` IS THE ONLY TIMEZONE DATABASE WE HAVE and it is enough:
 * it knows every IANA zone's history of offsets and transitions, which is
 * exactly what makes a local-calendar projection possible without shipping one.
 * The pattern — build the formatter with the zone, fall back rather than throw
 * on a name it does not know — is `usage.ts`'s, already in this tree.
 */
function partsIn(zone: string, at: number): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const read: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(at))) read[part.type] = part.value;
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    year: Number(read.year),
    month: Number(read.month),
    day: Number(read.day),
    // `hour12: false` renders midnight as 24 in some ICU versions; 24:xx is 00:xx.
    hour: Number(read.hour) % 24,
    minute: Number(read.minute),
    weekday: Math.max(0, DAYS.indexOf(read.weekday ?? "")),
  };
}

/**
 * A zone this machine's ICU does not know degrades to UTC rather than throwing.
 *
 * `usage.ts` makes the same choice and it is the right one here for a sharper
 * reason: a row is DURABLE. A zone that was valid when the row was written and
 * is not after an OS update would otherwise turn one bad row into a sweep that
 * throws — and `sweepSchedules`'s per-row catch would then silently stop that
 * row for ever. Degrading keeps it firing, an hour or two off, which is
 * recoverable; throwing does not.
 */
export function usableZone(zone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return "UTC";
  }
}

/** The instant at which `zone`'s wall clock reads these parts, or the closest
 *  one forward when that reading does not exist. */
function instantOf(zone: string, year: number, month: number, day: number, hour: number, minute: number): number {
  /**
   * TWO PASSES, BECAUSE THE OFFSET DEPENDS ON THE ANSWER. A zone's offset is
   * itself a function of the instant, so the first guess (treat the local parts
   * as UTC) is wrong by exactly that offset; measuring the error at the guess
   * and subtracting it lands on the right instant, and a second pass settles
   * the case where the correction crossed a transition.
   */
  let guess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  for (let pass = 0; pass < 2; pass += 1) {
    const seen = partsIn(zone, guess);
    const rendered = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, 0, 0);
    const drift = rendered - Date.UTC(year, month - 1, day, hour, minute, 0, 0);
    if (drift === 0) return guess;
    guess -= drift;
  }
  return guess;
}

/**
 * The next instant at which `rule` fires, strictly after `after`.
 *
 * ── NEVER `+ 86_400_000`, WHICH IS THE WHOLE POINT OF THIS FUNCTION ─────────
 *
 * Adding a day in milliseconds lands an hour off across a DST boundary,
 * silently, and only twice a year. So each candidate day is built in the ZONE'S
 * OWN CALENDAR and resolved back to an instant — which is also what makes a row
 * created in Madrid keep firing at 09:00 Madrid after the laptop flies to
 * Tokyo.
 *
 * ── THE TWO EDGES, DECIDED RATHER THAN INHERITED ────────────────────────────
 *
 * SPRING FORWARD — a local time that does not exist (02:30 on a day that jumps
 * 02:00→03:00). `instantOf` resolves it to the jump itself, so the run FIRES,
 * an hour "late" in local terms. Skipping would silently drop one occurrence a
 * year for anybody whose time sits in the lost hour, and a run that happens is
 * easier to explain than one that vanished.
 *
 * FALL BACK — a local time that happens TWICE (02:30 on a day that repeats
 * 02:00→03:00). `instantOf` resolves to the FIRST, and because the search below
 * only ever asks for times strictly after `after`, the second reading is never
 * returned as a separate occurrence. Fires once.
 */
export function nextOccurrence(rule: ScheduleRule, zone: string, after: number): number {
  if (rule.kind === "interval") {
    // No wall clock, no calendar: the next multiple strictly in the future.
    const every = Math.max(MIN_SCHEDULE_INTERVAL_MS, rule.everyMs);
    return after + every;
  }
  const safe = usableZone(zone);
  const wanted = rule.weekdays.length > 0 ? new Set(rule.weekdays) : undefined;
  // From the day `after` falls on, walk forward a day at a time IN THE ZONE'S
  // CALENDAR. Eight days covers every weekday set, including one that names
  // only the day we started on.
  const start = partsIn(safe, after);
  for (let ahead = 0; ahead <= 8; ahead += 1) {
    // `Date.UTC` + `ahead` normalises month and year ends for us; the parts are
    // then re-read in the zone so the candidate is a real local date there.
    const walked = new Date(Date.UTC(start.year, start.month - 1, start.day + ahead, 12, 0, 0, 0));
    const day = { year: walked.getUTCFullYear(), month: walked.getUTCMonth() + 1, day: walked.getUTCDate() };
    const candidate = instantOf(safe, day.year, day.month, day.day, rule.hour, rule.minute);
    if (candidate <= after) continue;
    if (wanted && !wanted.has(partsIn(safe, candidate).weekday)) continue;
    return candidate;
  }
  // A weekday set that matched nothing in eight days is impossible for a
  // non-empty set of 0–6; returning a week out is the harmless answer rather
  // than a throw inside a sweep.
  return after + 7 * 86_400_000;
}

/** What a sweep decided about one due row. */
export type ScheduleDecision = {
  /** Submit a turn for this row. */
  fire: boolean;
  /** Where `nextRunAt` moves to, always strictly after `now`. */
  nextRunAt: number;
  /** Set when the run was skipped — the instant that was missed, for the
   *  sentence the settings surface renders. */
  skipped?: number;
};

/**
 * Whether a row that is due should fire, and where it goes next.
 *
 * ── AN INTERVAL ROW FIRES AT MOST ONCE PER SWEEP ────────────────────────────
 *
 * and then advances IN WHOLE INTERVALS until it is strictly in the future.
 * Not `now + everyMs`, which drifts away from the original phase; and
 * emphatically not `dueAt + everyMs` once, which leaves the row still due and
 * produces ONE TURN PER MISSED INTERVAL on the next pass — a 72-turn burst
 * after a three-day sleep, which is the failure this whole issue is about.
 *
 * ── A FIXED-TIME ROW IS SKIPPED RATHER THAN FIRED LATE ──────────────────────
 *
 * past `SCHEDULE_GRACE_MS`. It records the instant it missed, re-aims to the
 * next matching occurrence, and submits nothing.
 */
export function decideSchedule(rule: ScheduleRule, zone: string, dueAt: number, now: number): ScheduleDecision {
  if (rule.kind === "interval") {
    const every = Math.max(MIN_SCHEDULE_INTERVAL_MS, rule.everyMs);
    let next = dueAt;
    // STRICTLY past `now`, so a row due exactly now does not stay due.
    while (next <= now) next += every;
    return { fire: true, nextRunAt: next };
  }
  const late = now - dueAt;
  if (late > SCHEDULE_GRACE_MS) {
    return { fire: false, nextRunAt: nextOccurrence(rule, zone, now), skipped: dueAt };
  }
  return { fire: true, nextRunAt: nextOccurrence(rule, zone, now) };
}
