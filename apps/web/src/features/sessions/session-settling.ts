export {
  canSettle,
  canSnooze,
  hasUnreadResult,
  isSettled,
  isShelved,
  isSnoozed,
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

type SnoozePresetId = "hour" | "three-hours" | "evening" | "tomorrow" | "next-week";

export type SnoozePreset = {
  id: SnoozePresetId;
  label: string;
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

function addDays(base: Date, days: number): Date {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

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

export function wakeLabel(snoozedUntil: number, now: number): string {
  const remaining = snoozedUntil - now;
  if (!Number.isFinite(remaining) || remaining <= 0) return "now";
  if (remaining < HOUR_MS) return `${Math.max(1, Math.ceil(remaining / MINUTE_MS))}m`;
  if (remaining < DAY_MS) return `${Math.ceil(remaining / HOUR_MS)}h`;
  return `${Math.ceil(remaining / DAY_MS)}d`;
}

const terminalsWord = (count: number) => `${count} terminal${count === 1 ? "" : "s"}`;

export function settleClosesText(terminals: number | undefined): string | undefined {
  return terminals && terminals > 0 ? `closes ${terminalsWord(terminals)}` : undefined;
}

export function settledTerminalsHint(terminals: number): string {
  return `${terminalsWord(terminals)} still open in this settled conversation, shells you opened included`;
}

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
