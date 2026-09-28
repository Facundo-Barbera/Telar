// Past this, a fixed-time run is skipped and re-aimed rather than fired late. Interval rows ignore it.
export const SCHEDULE_GRACE_MS = 5 * 60_000;

/** `weekdays` is empty for every day; 0 is Sunday, as in `Date.prototype.getDay`. */
export type ScheduleRule =
  | { kind: "interval"; everyMs: number }
  | { kind: "fixed"; hour: number; minute: number; weekdays: readonly number[] };

const MIN_SCHEDULE_INTERVAL_MS = 60_000;

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
    // Some ICU versions render midnight as 24 under `hour12: false`.
    hour: Number(read.hour) % 24,
    minute: Number(read.minute),
    weekday: Math.max(0, DAYS.indexOf(read.weekday ?? "")),
  };
}

// Rows are durable, so a zone the OS stops knowing must degrade to UTC rather than stop the row firing.
export function usableZone(zone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return "UTC";
  }
}

// A nonexistent local time (spring forward) resolves to the jump; a repeated one (fall back) to its first reading.
function instantOf(zone: string, year: number, month: number, day: number, hour: number, minute: number): number {
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

function intervalOf(rule: { everyMs: number }): number {
  return Math.max(MIN_SCHEDULE_INTERVAL_MS, rule.everyMs);
}

// Days are walked in the zone's own calendar, never by adding 86_400_000, so DST and travel keep the local time.
export function nextOccurrence(rule: ScheduleRule, zone: string, after: number): number {
  if (rule.kind === "interval") return after + intervalOf(rule);
  const safe = usableZone(zone);
  const wanted = rule.weekdays.length > 0 ? new Set(rule.weekdays) : undefined;
  const start = partsIn(safe, after);
  for (let ahead = 0; ahead <= 8; ahead += 1) {
    const walked = new Date(Date.UTC(start.year, start.month - 1, start.day + ahead, 12, 0, 0, 0));
    const candidate = instantOf(safe, walked.getUTCFullYear(), walked.getUTCMonth() + 1, walked.getUTCDate(), rule.hour, rule.minute);
    if (candidate <= after) continue;
    if (wanted && !wanted.has(partsIn(safe, candidate).weekday)) continue;
    return candidate;
  }
  return after + 7 * 86_400_000;
}

type ScheduleDecision = {
  fire: boolean;
  nextRunAt: number;
  skipped?: number;
};

// An interval row fires once per sweep and advances in whole intervals past `now`, so a long sleep never bursts.
export function decideSchedule(rule: ScheduleRule, zone: string, dueAt: number, now: number): ScheduleDecision {
  if (rule.kind === "interval") {
    let next = dueAt;
    while (next <= now) next += intervalOf(rule);
    return { fire: true, nextRunAt: next };
  }
  const nextRunAt = nextOccurrence(rule, zone, now);
  if (now - dueAt > SCHEDULE_GRACE_MS) return { fire: false, nextRunAt, skipped: dueAt };
  return { fire: true, nextRunAt };
}
