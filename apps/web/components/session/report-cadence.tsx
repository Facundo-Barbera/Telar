"use client";

/**
 * HOW OFTEN THIS CONVERSATION IS TOLD ABOUT ITS PEERS — issue #723.
 *
 * The engine grew the mechanism first: a session can hold routine peer reports
 * and take them as ONE merged notice per window, instead of being woken once per
 * event. What it did not grow was a way for a PERSON to see that a window is
 * set, change it, or tell that something is waiting on it — the cadence existed
 * only as a field an agent could set on itself, and the ~25 minutes the owner
 * asked for out loud stayed what it had always been: a convention an
 * orchestrator held by hand, which lapsed once for fifty minutes with nobody in
 * a position to notice.
 *
 * IT LIVES IN THE AGENTS PANEL, BESIDE RELATED WORK, and that is the owner's
 * own call rather than a default. A cadence is a property of a RELATIONSHIP —
 * who reports to whom, and how often — and this is the surface where those
 * already live: who started what, who is working on whose behalf, who is
 * following. The composer's controls were the other candidate, and they are
 * closer to hand; the header was the third, and the most visible. Both would
 * have put a fact about peers somewhere peers are not.
 *
 * WHAT IT SAYS WHILE IT IS HOLDING IS A COUNT, also the owner's call. The whole
 * risk of a held mailbox is that "held" and "lost" look identical from outside
 * it — the bug #631 part 2 fixed, which this feature could quietly reintroduce
 * — so the control that hides the reports is also the one that admits how many
 * it has. The age of the oldest was the alternative and it says something the
 * count does not; a row carries one trailing fact, and this is the one chosen.
 *
 * IT POLLS, because a peer's report arriving writes nothing to THIS session's
 * journal — there is no event to tail, and a surface that only re-read on its
 * own turn boundary would sit at "nothing waiting" while five reports piled up
 * behind it. One small read (`ReportWindowStatus` is two numbers) on the same
 * ten-second clock as the sections below, and only while the panel is open.
 */
import { useCallback, useEffect, useState } from "react";
import { TimerIcon } from "lucide-react";
import { MAX_REPORT_WINDOW_MINUTES, MIN_REPORT_WINDOW_MINUTES } from "@telar/engine-client";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PanelRow, PanelSectionLabel, type PanelTone } from "@/components/ui/panel";
import { createEngineApi } from "@/lib/engine/client";
import { LOCAL_HOST_ID } from "@/lib/hosts/book";
import { hostFetcher } from "@/lib/hosts/client";
import { cn } from "@/lib/utils";

/**
 * THE CADENCES THE MENU OFFERS — not the range the engine accepts.
 *
 * The contract allows any whole minute from one to a day, and an AGENT setting
 * its own window through `sessions_report_window` can name any of them. A human
 * picking from a list wants the few that are actually different decisions, and
 * 25 is here because it is the one the owner said out loud.
 */
export const CADENCES: readonly (number | null)[] = [null, 5, 10, 15, 25, 30, 60];

/**
 * THE MENU FOR A SESSION THAT IS ALREADY SET TO SOMETHING ELSE.
 *
 * An agent may have set 7 minutes, or 90, and a menu that could not show the
 * current setting would present a list with nothing selected — the control
 * disagreeing with the row above it. The odd value joins the list in its place
 * rather than replacing anything.
 */
export function cadenceOptions(minutes: number | null): (number | null)[] {
  if (minutes === null || CADENCES.includes(minutes)) return [...CADENCES];
  const numbers = [...CADENCES.filter((each): each is number => each !== null), minutes].sort((a, b) => a - b);
  return [null, ...numbers];
}

/** What a cadence is called. `null` is the engine's default: each report wakes
 *  the session as it lands. */
export function cadenceLabel(minutes: number | null): string {
  if (minutes === null) return "As they arrive";
  if (minutes === 1) return "Every minute";
  if (minutes < 60 || minutes % 60 !== 0) return `Every ${minutes} minutes`;
  const hours = minutes / 60;
  return hours === 1 ? "Every hour" : `Every ${hours} hours`;
}

/** The radio group's value for a cadence — `null` needs a name of its own,
 *  because a menu item cannot carry the absence of one. */
export const cadenceValue = (minutes: number | null): string => (minutes === null ? "arrival" : String(minutes));

/** And back. Anything unrecognised reads as the default rather than as a
 *  window, so a value this build does not know cannot silently start holding. */
export function cadenceFromValue(value: string): number | null {
  if (value === "arrival") return null;
  const minutes = Number(value);
  return Number.isInteger(minutes) && minutes >= MIN_REPORT_WINDOW_MINUTES && minutes <= MAX_REPORT_WINDOW_MINUTES ? minutes : null;
}

/**
 * THE SECOND LINE — what this setting MEANS, in one clause.
 *
 * A failed write owns the line while it is the most recent thing that happened:
 * a control that silently kept its old value would be the panel disagreeing
 * with a person who just pressed something.
 */
export function cadenceDetail(minutes: number | null, failed: boolean): string {
  if (failed) return "That did not go through — try again.";
  return minutes === null
    ? "Each routine report wakes this conversation as it arrives."
    : "Routine reports are held and delivered together. A task, a blocker and a result you follow still arrive at once.";
}

/**
 * WHAT THE ROW REPORTS ON ITS TRAILING EDGE.
 *
 * ONLY UNDER A WINDOW, and only when the box is not empty. A session with a
 * turn in flight holds its mail whatever its cadence says — so a count shown
 * beside "As they arrive" would credit this control with a delay it is not
 * causing. Nothing held is not a fact worth a number: the value of the mailbox
 * being visible is seeing that it IS holding something.
 */
export function heldLabel(minutes: number | null, held: number): string | undefined {
  return minutes !== null && held > 0 ? `${held} held` : undefined;
}

export type ReportCadenceViewProps = {
  minutes: number | null;
  held: number;
  /** A write is in flight — the trigger is disabled rather than optimistic. */
  busy?: boolean;
  failed?: boolean;
  onChoose?: (minutes: number | null) => void;
};

/**
 * The control itself, given its answer rather than fetching it — the same split
 * as `RelatedConversationsView` next door, and for the same reason: what the row
 * SAYS is a decision, and a decision made inside a component that owns a poll is
 * one nothing can put a case to without a server.
 */
export function ReportCadenceView({ minutes, held, busy = false, failed = false, onChoose }: ReportCadenceViewProps) {
  const waiting = heldLabel(minutes, held);
  const tone: PanelTone = waiting ? "info" : "none";
  return (
    <div className="flex flex-col">
      <PanelSectionLabel label="Reports from peers" />
      <PanelRow tone={tone} className="gap-2">
        <span className="flex min-w-0 flex-1 flex-col">
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={busy}
              render={
                <button
                  type="button"
                  aria-label="How often routine peer reports are delivered"
                  title="How often routine peer reports are delivered"
                  className="flex min-w-0 items-center gap-1.5 self-start rounded px-1 py-0.5 text-xs transition-colors hover:bg-muted disabled:opacity-40"
                />
              }
            >
              <TimerIcon className="size-3 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate">{cadenceLabel(minutes)}</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-52">
              {/* THE LABEL LIVES INSIDE THE GROUP IT NAMES — a label at depth
                  zero is associated with nothing for a screen reader, which
                  this repository has a test for (ui/dropdown-menu.test.ts). */}
              <DropdownMenuGroup>
                <DropdownMenuLabel>Deliver routine reports</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={cadenceValue(minutes)}
                  onValueChange={(next) => onChoose?.(cadenceFromValue(next))}
                >
                  {cadenceOptions(minutes).map((option) => (
                    <DropdownMenuRadioItem key={cadenceValue(option)} value={cadenceValue(option)}>
                      {cadenceLabel(option)}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <span className={cn("truncate pl-1 text-3xs", failed ? "text-destructive" : "text-muted-foreground")}>
            {cadenceDetail(minutes, failed)}
          </span>
        </span>
        {waiting && <span className="shrink-0 font-mono text-3xs text-muted-foreground tabular-nums">{waiting}</span>}
      </PanelRow>
    </div>
  );
}

/** What the surface holds while it reads, and what it says when it could not. */
type Read = { minutes: number | null; held: number; done: boolean };

const EMPTY_READ: Read = { minutes: null, held: 0, done: false };

/**
 * THE READ, on the same ten-second clock as the sections below it.
 *
 * NOTHING AT ALL UNTIL THE FIRST ANSWER. A control that rendered "As they
 * arrive" and then corrected itself to "Every 25 minutes" would be claiming a
 * setting it had not read yet — and on this control, that claim is the
 * difference between "nothing is being held" and "five things are".
 */
function useReportWindow(sessionId: string | undefined, hostId: string | undefined, visible: boolean, nudge: number): Read {
  const [read, setRead] = useState<Read>(EMPTY_READ);
  useEffect(() => {
    if (!sessionId || !visible) return;
    let live = true;
    const api = createEngineApi(hostFetcher(hostId ?? LOCAL_HOST_ID));
    const tick = async () => {
      const status = await api.sessionReportWindow(sessionId).then(
        (value) => value,
        () => undefined,
      );
      if (!live) return;
      // A FAILED READ PRESERVES THE LAST GOOD ANSWER, and stays silent until
      // there has been one: "as they arrive, nothing held" invented from a
      // dropped request is the one wrong answer this row can give.
      if (status === undefined) return;
      setRead({ minutes: status.reportWindowMinutes, held: status.held, done: true });
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 10_000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [sessionId, hostId, visible, nudge]);
  return read;
}

export function ReportCadence({
  sessionId,
  hostId,
  /** False while the panel is behind another tab — nothing polls off screen. */
  visible = true,
}: {
  sessionId?: string;
  hostId?: string;
  visible?: boolean;
}) {
  const [nudge, setNudge] = useState(0);
  const read = useReportWindow(sessionId, hostId, visible, nudge);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  /**
   * THE WRITE IS NOT OPTIMISTIC. The next tick is at most ten seconds away and
   * a row that showed a cadence the engine refused would be lying about which
   * reports are being held — so the control waits, then asks the poll to come
   * round now rather than in ten seconds.
   */
  const choose = useCallback(
    async (minutes: number | null) => {
      if (!sessionId || busy) return;
      setBusy(true);
      const api = createEngineApi(hostFetcher(hostId ?? LOCAL_HOST_ID));
      const ok = await api.updateSession(sessionId, { reportWindowMinutes: minutes }).then(
        () => true,
        () => false,
      );
      setFailed(!ok);
      setBusy(false);
      setNudge((current) => current + 1);
    },
    [busy, hostId, sessionId],
  );

  if (!sessionId || !read.done) return null;
  return (
    <ReportCadenceView
      minutes={read.minutes}
      held={read.held}
      busy={busy}
      failed={failed}
      onChoose={(minutes) => void choose(minutes)}
    />
  );
}
