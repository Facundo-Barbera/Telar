"use client";

/**
 * THE STANDING INSTRUCTIONS A PERSON HAS ASKED FOR — issue #543.
 *
 * ══ THE SKIPPED SENTENCE IS THE POINT OF THIS SURFACE, NOT THE LIST ══
 *
 * The engine is an Electron child and Telar quits when its last window closes,
 * so a scheduled task CANNOT fire while the app is closed. That is the
 * feature's boundary rather than a bug to design around — and the only way to
 * ship it wrong is to ship it silently. Somebody who sets "every weekday at
 * 09:00", opens Telar at 14:00 and finds nothing has run has been handed a
 * broken scheduler unless the row itself says what happened. An invisible
 * boundary is indistinguishable from a bug.
 *
 * `retention-section.tsx` states the same instinct about a different subject:
 * a person who deletes their history and then sees the same number "has been
 * given the worst possible outcome", so the copy explains rather than hides.
 *
 * ══ NEXT RUN IS RENDERED IN THE ROW'S OWN ZONE, NEVER THIS MACHINE'S ══
 *
 * A row made in Madrid keeps firing at 09:00 Madrid from Tokyo, so showing it
 * at the reader's local time would make a correct row look wrong. The IANA name
 * is printed beside the time, because "09:00" alone is the sentence that starts
 * the argument.
 *
 * ══ IT READS ONCE AND NEVER ON A TIMER ══
 *
 * `RetentionSection`'s rule, and #629's: a row changes only when a sweep
 * touches it — at most every thirty seconds, usually never — and this pane is
 * looked at rather than watched.
 *
 * ══ THERE IS NO "RUN NOW" BUTTON, DELIBERATELY ══
 *
 * It looks like a kindness and it is a second way to start a turn carrying none
 * of the sweep's re-aiming: pressed twice it gives two turns and a `nextRunAt`
 * that means nothing. Sending the prompt is what the composer is for.
 */

import { useCallback, useEffect, useState } from "react";
import type { Schedule } from "@telar/engine-client";
import { CalendarClockIcon, Trash2Icon } from "lucide-react";
import { createEngineApi } from "@/lib/engine/client";
import { Button } from "@/components/ui/button";
import { SettingsGroup } from "./settings-shell";

const api = createEngineApi();

/**
 * An instant as the ROW's zone reads it — the only rendering that is true of
 * the schedule rather than of whoever is looking.
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
    // engine made the same choice when it stored it (`usableZone`). A row is
    // durable and has to keep being readable after an OS update moves the
    // tzdata under it.
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
  // Weekdays are the case worth naming, because "Mon, Tue, Wed, Thu, Fri" is
  // the thing somebody actually asked for and reads worse spelled out.
  const weekdays = days.length === 5 && days.join() === "Mon,Tue,Wed,Thu,Fri";
  return `${weekdays ? "Every weekday" : days.join(", ")} at ${at}`;
}

/**
 * What a row says about its last run.
 *
 * A SENTENCE NAMING THE INSTANT THAT WAS MISSED, because "skipped" alone tells
 * a reader that something did not happen without telling them what. The instant
 * is what lets them recognise it as the morning the laptop was shut — and the
 * clause after it is what stops them waiting for a late run that is never
 * coming.
 *
 * A ROW THAT HAS NEVER RUN SAYS NOTHING. A sentence under every row is a
 * sentence nobody reads, and this one has to be noticed exactly once.
 */
export function lastRunSentence(row: Pick<Schedule, "zone" | "lastRunStatus" | "lastRunAt" | "lastSkippedAt">): string | undefined {
  if (row.lastRunStatus === "skipped" && row.lastSkippedAt !== undefined) {
    return `Skipped ${inZone(row.lastSkippedAt, row.zone)} — Telar was not running, so it was re-aimed rather than run late.`;
  }
  if (row.lastRunStatus === "fired" && row.lastRunAt !== undefined) return `Last ran ${inZone(row.lastRunAt, row.zone)}.`;
  if (row.lastRunStatus === "fired") return "Last run went through.";
  return undefined;
}

/** One row, separated from the fetching half so a test can render it with two
 *  numbers rather than a fake engine. */
export function ScheduleRowView({ row, onForget }: { row: Schedule; onForget?: (id: string) => void }) {
  const sentence = lastRunSentence(row);
  return (
    <li className="flex items-start gap-3 rounded-md border border-border px-3 py-2">
      <CalendarClockIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs text-foreground">{row.prompt}</p>
        <p className="mt-0.5 text-2xs text-muted-foreground">
          {ruleLabel(row.rule)}
          {" · "}
          {row.enabled ? `next ${inZone(row.nextRunAt, row.zone)}` : "paused"}
          {/* THE IANA NAME, on the row. Without it "09:00" is the start of an
              argument about whose nine o'clock. */}
          <span className="ml-1.5 font-mono">{row.zone}</span>
        </p>
        {/* THE BOUNDARY, SAID OUT LOUD — see the header. */}
        {sentence && (
          <p className={`mt-0.5 text-2xs ${row.lastRunStatus === "skipped" ? "text-warning" : "text-muted-foreground"}`}>{sentence}</p>
        )}
      </div>
      {onForget && (
        <Button variant="ghost" size="icon-sm" aria-label="Forget this schedule" onClick={() => onForget(row.id)}>
          <Trash2Icon className="size-3.5" />
        </Button>
      )}
    </li>
  );
}

export function SchedulesSection() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      setSchedules((await api.schedules()).schedules);
      setFailure(undefined);
    } catch {
      setFailure("Telar could not read the schedules — the engine did not answer.");
    } finally {
      setLoaded(true);
    }
  }, []);

  /** ONCE, ON OPEN. No timer: see the header. */
  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load]);

  const forget = async (id: string) => {
    try {
      await api.deleteSchedule(id);
      setSchedules((rows) => rows.filter((row) => row.id !== id));
    } catch {
      setFailure("Telar could not forget that schedule — the engine did not answer.");
    }
  };

  return (
    <SettingsGroup
      title="Scheduled work"
      description="A conversation can ask to be woken on a clock. Telar has to be open for one to fire — the engine goes when the app does — so a run missed while Telar was closed is skipped and re-aimed rather than run late, and says so below."
    >
      <div className="px-4">
        {failure && <p className="mb-2 text-2xs text-destructive">{failure}</p>}
        {loaded && schedules.length === 0 && !failure && (
          <p className="text-2xs text-muted-foreground">
            Nothing is scheduled. A conversation sets one for itself with <code className="font-mono">sessions_schedule</code>.
          </p>
        )}
        {schedules.length > 0 && (
          <ul className="flex flex-col gap-2">
            {schedules.map((row) => (
              <ScheduleRowView key={row.id} row={row} onForget={(id) => void forget(id)} />
            ))}
          </ul>
        )}
      </div>
    </SettingsGroup>
  );
}
