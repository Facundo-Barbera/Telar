// Snooze presets for the sidebar inbox.
//
// Every preset is a pure function of an injected `now`, so the whole set is
// testable without touching the clock. They resolve against LOCAL time on
// purpose: "tomorrow morning" means the user's morning, and Date's getters
// already speak the browser's zone. Computing them client-side and sending an
// absolute epoch-ms instant to the API keeps the server free of any timezone
// opinion — it only ever compares numbers.

export const SNOOZE_HOUR_MORNING = 9;

export type SnoozePreset = {
  id: string;
  label: string;
  /** Resolves to the epoch-ms instant the session should return to the inbox. */
  at: (now: Date) => number;
};

// Local-midnight-anchored day arithmetic. Constructing a fresh Date from the
// Y/M/D parts rather than adding 24h of milliseconds is what makes this correct
// across a DST boundary: the day after a spring-forward is 23 hours long, and
// "+86_400_000" would land at 10am on it.
function atHourDaysAhead(now: Date, days: number, hour: number): number {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, hour, 0, 0, 0);
  return day.getTime();
}

/** Days from `now` to the next Monday — always 1..7, never today. */
function daysToNextMonday(now: Date): number {
  const MONDAY = 1;
  return ((MONDAY - now.getDay() + 7) % 7) || 7;
}

export const SNOOZE_PRESETS: readonly SnoozePreset[] = [
  {
    id: "hour",
    label: "In an hour",
    at: (now) => now.getTime() + 60 * 60 * 1000,
  },
  {
    id: "evening",
    label: "This evening",
    // Only offered while it is still ahead — see snoozePresetsFor below.
    at: (now) => atHourDaysAhead(now, 0, 18),
  },
  {
    id: "tomorrow",
    label: "Tomorrow morning",
    at: (now) => atHourDaysAhead(now, 1, SNOOZE_HOUR_MORNING),
  },
  {
    id: "monday",
    label: "Next Monday",
    at: (now) => atHourDaysAhead(now, daysToNextMonday(now), SNOOZE_HOUR_MORNING),
  },
];

/**
 * The presets worth showing at `now`, in order.
 *
 * Drops any whose instant has already passed today — offering "This evening" at
 * 11pm would either no-op or, worse, quietly resolve to a time in the past and
 * bounce straight back out of the shelf.
 */
export function snoozePresetsFor(now: Date): SnoozePreset[] {
  const ms = now.getTime();
  return SNOOZE_PRESETS.filter((preset) => preset.at(now) > ms);
}
