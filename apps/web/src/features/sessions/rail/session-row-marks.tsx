"use client";

import { useEffect, useState } from "react";
import { AlarmClockIcon, CircleDashedIcon, CircleDotIcon, HardDriveIcon, PinIcon, SquareTerminalIcon } from "lucide-react";
import { fmtAgo } from "@/ui/format";
import { ACTIVITY_TONE, fmtDuration, rowStatusText } from "../session-activity";
import type { SessionBand, SidebarSession } from "../session-list";
import { settledTerminalsHint, wakeLabel } from "../session-settling";

const yieldOnHover = "transition-opacity group-hover/session:opacity-0 group-focus-within/session:opacity-0";

function TickingDuration({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(startedAt);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const timer = window.setInterval(tick, 5_000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return <span className="tabular-nums">{fmtDuration(startedAt, now)}</span>;
}

function DriveStatus({ session }: { session: SidebarSession }) {
  const unmounted = session.projectAvailability === "unmounted";
  return (
    <span
      className={`inline-flex min-w-0 shrink items-center gap-1 text-2xs font-medium text-muted-foreground ${yieldOnHover}`}
      title={
        unmounted
          ? `The drive holding ${session.projectName ?? "this project"} is not connected. Its work is still on it.`
          : `${session.workspacePath ?? "This session's folder"} is not on this machine any more.`
      }
    >
      <HardDriveIcon className="size-3 shrink-0" />
      <span role="status" className="truncate">
        {unmounted ? "Drive away" : "Folder gone"}
      </span>
    </span>
  );
}

function PreparationStatus({ preparation }: { preparation: NonNullable<SidebarSession["preparation"]> }) {
  return (
    <span
      className={`inline-flex min-w-0 shrink items-center gap-1 text-2xs font-medium ${
        preparation.state === "failed" ? "text-warning" : "text-muted-foreground"
      } ${yieldOnHover}`}
      title={preparation.error}
    >
      {preparation.state === "preparing" ? (
        <>
          <CircleDashedIcon className="size-3 animate-spin [animation-duration:3s]" />
          <span role="status">Preparing</span>
        </>
      ) : (
        <>
          <CircleDotIcon className="size-3 shrink-0" />
          <span role="status" className="truncate">
            {preparation.error?.split("\n")[0]?.trim() || "Worktree setup failed"}
          </span>
        </>
      )}
    </span>
  );
}

export function RowStatus({ session, band, renderedAt }: { session: SidebarSession; band: SessionBand; renderedAt: number }) {
  if (session.projectAvailability === "unmounted" || session.projectAvailability === "missing") return <DriveStatus session={session} />;
  if (session.preparation) return <PreparationStatus preparation={session.preparation} />;
  if (session.draft) return <span className={`shrink-0 text-2xs text-sidebar-foreground/45 ${yieldOnHover}`}>Draft</span>;
  if (band === "snoozed" && session.snoozedUntil !== undefined) {
    return (
      <span className={`inline-flex shrink-0 items-center gap-1 text-2xs tabular-nums text-sidebar-foreground/45 ${yieldOnHover}`}>
        <AlarmClockIcon className="size-3" />
        {wakeLabel(session.snoozedUntil, renderedAt)}
      </span>
    );
  }
  const { badge, time } = rowStatusText(session, renderedAt);
  if (!badge) return <span className={`shrink-0 text-2xs tabular-nums text-sidebar-foreground/45 ${yieldOnHover}`}>{time}</span>;
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 text-2xs font-medium ${ACTIVITY_TONE[badge.tone]} ${yieldOnHover}`}>
      {badge.ticking ? (
        <CircleDashedIcon className="size-3 animate-spin [animation-duration:3s]" />
      ) : badge.tone === "attention" ? (
        <CircleDotIcon className="size-3" />
      ) : null}
      <span role="status" title={badge.hint}>{badge.label}</span>
      {badge.ticking && session.activityAt !== undefined ? <TickingDuration startedAt={session.activityAt} /> : null}
    </span>
  );
}

export function RowMarks({
  session,
  band,
  renderedAt,
  heldTerminals,
}: {
  session: SidebarSession;
  band: SessionBand;
  renderedAt: number;
  heldTerminals: number;
}) {
  return (
    <>
      {session.wokeAt !== undefined && Number.isFinite(session.wokeAt) ? (
        <span
          role="img"
          aria-label="Woke up"
          title={`Woke ${fmtAgo(session.wokeAt, renderedAt)}`}
          className="size-1.5 shrink-0 rounded-full bg-primary"
        />
      ) : null}
      {band === "pinned" ? (
        <span role="img" aria-label="Pinned" title="Pinned" className="shrink-0 text-sidebar-foreground/45">
          <PinIcon className="size-3" />
        </span>
      ) : null}
      {heldTerminals > 0 ? (
        <span
          role="img"
          aria-label={settledTerminalsHint(heldTerminals)}
          title={settledTerminalsHint(heldTerminals)}
          className="inline-flex shrink-0 items-center gap-0.5 text-2xs tabular-nums text-sidebar-foreground/60"
        >
          <SquareTerminalIcon className="size-3" />
          {heldTerminals}
        </span>
      ) : null}
    </>
  );
}
