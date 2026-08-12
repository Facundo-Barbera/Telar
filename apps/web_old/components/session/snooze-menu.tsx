"use client";

// The snooze control, promoted out of the overflow menu onto the row itself.
//
// Deferring work is one of the two gestures an inbox exists for (the other is
// settling), so it costs one click here rather than two through a "⋯". The
// same presets are still reachable from the overflow menu for anyone who goes
// looking there — both render from SNOOZE_PRESETS, so they cannot drift.

import { useState } from "react";
import { ClockIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { patchChat } from "@/lib/chat-actions";
import { snoozePresetsFor } from "@/lib/snooze";
import type { SidebarSession } from "@/lib/session-list";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function SnoozeMenu({
  session,
  snoozed,
  onDone,
  className,
}: {
  session: SidebarSession;
  snoozed: boolean;
  onDone?: () => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  // Recomputed per open rather than per render: "this evening" must not still
  // be offered in a tab left sitting past 6pm, and reading the clock during
  // render is impure.
  const presets = open ? snoozePresetsFor(new Date()) : [];

  const apply = (until: number | null) => {
    void patchChat(session.id, { snoozeUntil: until }).then(() => onDone?.());
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={snoozed ? "Change snooze" : "Snooze session"}
            title={snoozed ? "Change snooze" : "Snooze"}
            className={cn(
              "text-muted-foreground hover:text-foreground",
              snoozed && "text-primary",
              className,
            )}
          />
        }
      >
        <ClockIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuLabel>Come back…</DropdownMenuLabel>
        {presets.map((preset) => (
          <DropdownMenuItem key={preset.id} onClick={() => apply(preset.at(new Date()))}>
            {preset.label}
          </DropdownMenuItem>
        ))}
        {snoozed ? (
          <DropdownMenuItem onClick={() => apply(null)}>Wake now</DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
