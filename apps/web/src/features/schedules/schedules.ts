import type { Schedule } from "@telar/engine-client";

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
    return new Date(at).toISOString();
  }
}

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

export function lastRunSentence(row: Pick<Schedule, "zone" | "lastRunStatus" | "lastRunAt" | "lastSkippedAt">): string | undefined {
  if (row.lastRunStatus === "skipped" && row.lastSkippedAt !== undefined) {
    return `Skipped ${inZone(row.lastSkippedAt, row.zone)}: Telar was closed.`;
  }
  if (row.lastRunStatus === "fired" && row.lastRunAt !== undefined) return `Last ran ${inZone(row.lastRunAt, row.zone)}`;
  return undefined;
}
