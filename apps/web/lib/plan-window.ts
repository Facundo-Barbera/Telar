// Pure helpers for rendering plan-usage windows. No React, no fs — so the two
// things that are easy to get quietly wrong (what a meter is CALLED, and how
// many rings a wheel draws) are testable on their own.
//
// Both exist because the set of windows a provider reports is no longer fixed.
// Codex dropped its 5-hour limit in July 2026 and kept only the weekly one, and
// may well restore it (see lib/codex-usage.ts for the measurements). So:
//   · a meter labels itself from the window's real duration when the provider
//     reports one, instead of from the slot it was parsed into, and
//   · a wheel draws one ring per window that ACTUALLY EXISTS, rather than a
//     fixed pair with an empty inner circle standing in for missing data.
import type { PlanWindow } from "@/lib/store";

const WEEK_MIN = 7 * 24 * 60;
const DAY_MIN = 24 * 60;

// "5h" · "Weekly" · "3d" · "45m". `fallback` is what to say when the provider
// didn't report a duration — Claude's windows arrive pre-named by the SDK
// (five_hour / seven_day), so their labels are the caller's to supply.
export function windowLabel(minutes: number | null | undefined, fallback: string): string {
  if (minutes == null || !Number.isFinite(minutes) || minutes <= 0) return fallback;
  if (minutes === WEEK_MIN) return "Weekly";
  if (minutes >= DAY_MIN) {
    const days = minutes / DAY_MIN;
    return `${Number.isInteger(days) ? days : days.toFixed(1)}d`;
  }
  if (minutes >= 60) {
    const hours = minutes / 60;
    return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
  }
  return `${minutes}m`;
}

// How long until a window resets, as a human reads it.
//
// ROLLS ALL THE WAY UP. The old version stopped at hours, so a weekly window
// two days out rendered "66h 31m" and one four days out "96h 57m" — technically
// correct and useless: nobody converts 96 hours into "four days" at a glance,
// and the number is big enough to look alarming while meaning the opposite.
// Days appear past 24h, and the trailing unit is dropped once it stops
// mattering ("4d" rather than "4d 0h").
export function formatResetIn(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const ms = new Date(iso).getTime() - now;
  if (!Number.isFinite(ms)) return "—";
  if (ms <= 0) return "now";
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

// Compact form for the pill in the session bar, where "Weekly" is too wide.
export function windowLabelShort(minutes: number | null | undefined, fallback: string): string {
  const label = windowLabel(minutes, fallback);
  return label === "Weekly" ? "wk" : label;
}

// The wheel's geometry. One entry per window that has a real utilization,
// OUTERMOST FIRST — so a lone weekly window is drawn on the outer circle at
// full size rather than as a small inner ring with a hollow outer track above
// it. When both windows exist the old anatomy is preserved exactly: session
// outside, weekly inside.
export const RING_RADII = [12, 7] as const;

export type PlanRing = {
  key: "fiveHour" | "sevenDay";
  pct: number;
  radius: number;
};

export function planRings(
  five: number | null | undefined,
  week: number | null | undefined,
): PlanRing[] {
  const present: { key: PlanRing["key"]; pct: number }[] = [];
  if (five != null) present.push({ key: "fiveHour", pct: five });
  if (week != null) present.push({ key: "sevenDay", pct: week });
  return present.map((w, i) => ({ ...w, radius: RING_RADII[i] }));
}

export type UsedWindow = {
  key: string;
  label: string; // "5-hour" · "Weekly" · "Weekly · Opus"
  short: string; // "5h" · "wk" — for the session bar's pill
  window: PlanWindow;
};

// Every window on a snapshot that actually carries a utilization, in the order
// a breakdown should list them. Shared by the wheel's tooltip, the pill and the
// settings meters so none of them can drift into showing a window the others
// hide. The fallback names are the ones Claude's SDK implies (five_hour /
// seven_day); a provider that reports a real duration overrides them.
export function usedWindows(
  snap:
    | {
        fiveHour?: PlanWindow | null;
        sevenDay?: PlanWindow | null;
        sevenDayOpus?: PlanWindow | null;
        sevenDaySonnet?: PlanWindow | null;
      }
    | null
    | undefined,
): UsedWindow[] {
  if (!snap) return [];
  const rows: UsedWindow[] = [];
  const push = (
    key: string,
    w: PlanWindow | null | undefined,
    long: string,
    short: string,
    suffix = "",
  ) => {
    if (!w || w.utilization == null) return;
    rows.push({
      key,
      label: windowLabel(w.windowMinutes, long) + suffix,
      short: windowLabelShort(w.windowMinutes, short),
      window: w,
    });
  };
  push("fiveHour", snap.fiveHour, "5-hour", "5h");
  push("sevenDay", snap.sevenDay, "Weekly", "wk");
  push("sevenDayOpus", snap.sevenDayOpus, "Weekly", "wk", " · Opus");
  push("sevenDaySonnet", snap.sevenDaySonnet, "Weekly", "wk", " · Sonnet");
  return rows;
}
