import type { Schedule } from "@telar/engine-client";

/**
 * An instant as the ROW's zone reads it. A row made in Madrid keeps firing at
 * 09:00 Madrid from Tokyo, so the reader's local time would make a correct row
 * look wrong.
 */
export function inZone(at: number, zone: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: zone,
      weekday: "short",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(at));
  } catch {
    // A zone this machine's ICU does not know must not blank the row — the
    // engine stored it anyway (`usableZone`), and an OS update can move tzdata.
    return new Date(at).toISOString();
  }
}

/** What the row fires on, in words rather than a rule object. */
export function ruleLabel(rule: Schedule["rule"]): string {
  if (rule.kind === "interval") {
    const minutes = Math.round(rule.everyMs / 60_000);
    if (minutes % 1440 === 0) return `Every ${minutes / 1440} ${minutes === 1440 ? "day" : "days"}`;
    if (minutes % 60 === 0) return `Every ${minutes / 60} ${minutes === 60 ? "hour" : "hours"}`;
    return `Every ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  const at = `${String(rule.hour).padStart(2, "0")}:${String(rule.minute).padStart(2, "0")}`;
  if (rule.weekdays.length === 0) return `Every day at ${at}`;
  const NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const days = [...rule.weekdays].sort((a, b) => a - b).map((day) => NAMES[day] ?? "?");
  const weekdays = days.length === 5 && days.join() === "Mon,Tue,Wed,Thu,Fri";
  return `${weekdays ? "Every weekday" : days.join(", ")} at ${at}`;
}

/**
 * What a row says about its last run. A SKIPPED run names the instant it
 * missed, because a schedule cannot fire while Telar is closed and an invisible
 * boundary is indistinguishable from a broken scheduler. A row that has never
 * run says nothing, so the warning is noticed when it appears.
 */
export function lastRunSentence(row: Pick<Schedule, "zone" | "lastRunStatus" | "lastRunAt" | "lastSkippedAt">): string | undefined {
  if (row.lastRunStatus === "skipped" && row.lastSkippedAt !== undefined) {
    return `Skipped ${inZone(row.lastSkippedAt, row.zone)}: Telar was closed.`;
  }
  if (row.lastRunStatus === "fired" && row.lastRunAt !== undefined) return `Last ran ${inZone(row.lastRunAt, row.zone)}`;
  return undefined;
}
