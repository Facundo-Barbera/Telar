"use client";

import { AlarmClockIcon, CircleCheckIcon, CircleStopIcon, ClockIcon, UndoIcon } from "lucide-react";
import type { LiveSessionRow } from "@telar/engine-client";
import { Button } from "@/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/ui/dropdown-menu";
import type { SessionBand, SidebarSession } from "../session-list";
import { closeRowTerminals, patchSession, withSettling, withSnooze, type SessionRowChanged } from "../session-mutations";
import { canSettle, canSnooze, settleClosesText, snoozePresets, type SettlingActivity } from "../session-settling";
import { SessionInboxMenu, type SessionRowMenuProps } from "./session-inbox-menu";

type Mutate = (after: SidebarSession, send: () => Promise<LiveSessionRow>) => void;

function SnoozeMenu({ session, disabled, renderedAt, mutate }: { session: SidebarSession; disabled: boolean; renderedAt: number; mutate: Mutate }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Snooze session"
            title="Snooze"
            disabled={disabled}
            className="text-muted-foreground hover:text-foreground"
          />
        }
      >
        <ClockIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {snoozePresets(new Date(renderedAt)).map((preset) => (
          <DropdownMenuItem
            key={preset.id}
            onClick={() => mutate(withSnooze(session, preset.until), () => patchSession(session, { snoozedUntil: preset.until }))}
          >
            <span className="flex-1">{preset.label}</span>
            <span className="font-mono text-3xs tabular-nums text-muted-foreground/60">{preset.when}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function RowActions({
  menuProps,
  session,
  activity,
  renderedAt,
  onRowChanged,
  band,
  slim,
  unsettles,
  heldTerminals,
  mutate,
  unsettle,
}: {
  menuProps: SessionRowMenuProps;
  session: SidebarSession;
  activity: SettlingActivity;
  renderedAt: number;
  onRowChanged: SessionRowChanged;
  band: SessionBand;
  slim: boolean;
  unsettles: boolean;
  heldTerminals: number;
  mutate: Mutate;
  unsettle: () => void;
}) {
  const settleCloses = settleClosesText(session.terminals);
  const closeLabel = heldTerminals === 1 ? "Close its terminal" : `Close its ${heldTerminals} terminals`;
  return (
    <span
      className={`absolute right-1 z-10 flex items-center gap-0.5 rounded-md bg-sidebar-accent opacity-0 shadow-1 transition-opacity group-hover/session:opacity-100 group-focus-within/session:opacity-100 has-data-popup-open:opacity-100 ${
        slim ? "top-1/2 -translate-y-1/2" : "top-1.5"
      }`}
    >
      {!session.archived && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={unsettles ? "Return to the list" : "Settle session"}
          title={unsettles ? "Return to the list" : settleCloses ? `Settle — ${settleCloses}` : "Settle"}
          disabled={!unsettles && !canSettle(activity)}
          className="text-muted-foreground hover:text-foreground"
          onClick={() => {
            if (unsettles) unsettle();
            else mutate(withSettling(session, "settled"), () => patchSession(session, { settledOverride: "settled" }));
          }}
        >
          {unsettles ? <UndoIcon /> : <CircleCheckIcon />}
        </Button>
      )}
      {heldTerminals > 0 && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={closeLabel}
          title={closeLabel}
          className="text-muted-foreground hover:text-foreground"
          onClick={() => void closeRowTerminals({ row: session, onRowChanged })}
        >
          <CircleStopIcon />
        </Button>
      )}
      {band === "snoozed" ? (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Wake session now"
          title="Wake now"
          className="text-muted-foreground hover:text-foreground"
          onClick={() => mutate(withSnooze(session, null), () => patchSession(session, { snoozedUntil: null }))}
        >
          <AlarmClockIcon />
        </Button>
      ) : (
        band !== "settled" && <SnoozeMenu session={session} disabled={!canSnooze(activity)} renderedAt={renderedAt} mutate={mutate} />
      )}
      <SessionInboxMenu {...menuProps} />
    </span>
  );
}
