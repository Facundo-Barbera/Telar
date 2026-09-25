"use client";

/**
 * THIS CONVERSATION'S SCHEDULES, in its own masthead.
 *
 * A schedule belongs to the session that set it (`sessions_schedule`), so it is
 * shown and forgotten here rather than in a Settings pane listing every
 * session's. Absent when there are none: a clock with a zero is a question
 * nobody asked.
 *
 * READ ON MOUNT AND WHEN THE LAST TURN CHANGES STATE (`refreshKey`), never on a
 * timer (#629). A schedule is set by a turn and fires as one, so the turn is
 * the only moment the list can have moved.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Schedule } from "@telar/engine-client";
import { AlarmClockIcon, InfoIcon, Trash2Icon } from "lucide-react";
import { createEngineApi } from "@/lib/engine/client";
import { hostFetcher } from "@/lib/hosts/client";
import { inZone, lastRunSentence, ruleLabel } from "@/lib/schedules";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const BOUNDARY = "Runs only while Telar is open. A run missed while it was closed is skipped, not run late.";

function ScheduleRow({ row, onDelete }: { row: Schedule; onDelete: (id: string) => void }) {
  const sentence = lastRunSentence(row);
  return (
    <li className="flex items-start gap-2 rounded-xl px-2.5 py-1.5 hover:bg-muted/70">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm" title={row.prompt}>
          {row.prompt}
        </p>
        <p className="mt-0.5 text-2xs text-muted-foreground">
          {ruleLabel(row.rule)} · {row.enabled ? `next ${inZone(row.nextRunAt, row.zone)}` : "paused"}
          {/* The zone beside the time: "09:00" alone begs "whose nine o'clock". */}
          <span className="ml-1.5 font-mono">{row.zone}</span>
        </p>
        {sentence && <p className={`mt-0.5 text-2xs ${row.lastRunStatus === "skipped" ? "text-warning" : "text-muted-foreground"}`}>{sentence}</p>}
      </div>
      <Button variant="ghost" size="icon-sm" aria-label="Delete schedule" title="Delete schedule" onClick={() => onDelete(row.id)}>
        <Trash2Icon className="size-3.5" />
      </Button>
    </li>
  );
}

export function SessionSchedules({ sessionId, hostId, refreshKey }: { sessionId: string; hostId: string; refreshKey?: string }) {
  const api = useMemo(() => createEngineApi(hostFetcher(hostId)), [hostId]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [failure, setFailure] = useState<string>();
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setSchedules((await api.schedules(sessionId)).schedules);
    } catch {
      // A masthead glyph has nowhere to say "could not read"; the next turn retries.
    }
  }, [api, sessionId]);

  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load, refreshKey]);

  const remove = async (id: string) => {
    try {
      await api.deleteSchedule(id);
      setFailure(undefined);
      if (schedules.every((row) => row.id === id)) setOpen(false);
      setSchedules((rows) => rows.filter((row) => row.id !== id));
    } catch {
      setFailure("Could not delete it. Try again.");
    }
  };

  if (schedules.length === 0) return null;
  const label = `${schedules.length} ${schedules.length === 1 ? "schedule" : "schedules"}`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          // One family with Run, Open and Notes beside it.
          <Button type="button" variant="outline" size="sm" aria-label={label} aria-expanded={open} title={label} className="h-7 gap-1 px-2 text-muted-foreground" />
        }
      >
        <AlarmClockIcon className="size-4" />
        <span className="text-xs tabular-nums">{schedules.length}</span>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="bottom"
        sideOffset={8}
        aria-label="Schedules"
        className="max-h-[min(32rem,calc(100vh-6rem))] w-80 gap-0 overflow-y-auto rounded-3xl border border-border bg-popover p-2.5 text-popover-foreground shadow-3"
      >
        <div className="flex items-center gap-1.5 px-2 pb-1.5 pt-2 text-xs font-medium text-muted-foreground">
          <span>Schedules</span>
          <Tooltip>
            <TooltipTrigger
              render={
                <button type="button" aria-label="When schedules run" data-info={BOUNDARY} className="flex items-center text-muted-foreground/60 hover:text-foreground">
                  <InfoIcon className="size-3.5" />
                </button>
              }
            />
            <TooltipContent side="top" className="max-w-72 text-xs leading-snug">
              {BOUNDARY}
            </TooltipContent>
          </Tooltip>
        </div>
        {failure && <p className="px-2 pb-1 text-2xs text-destructive">{failure}</p>}
        <ul className="space-y-0.5">
          {schedules.map((row) => (
            <ScheduleRow key={row.id} row={row} onDelete={(id) => void remove(id)} />
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
