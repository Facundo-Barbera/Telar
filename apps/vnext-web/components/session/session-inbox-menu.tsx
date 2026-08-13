"use client";

// The per-row overflow menu for the sidebar's session list. Ported from the
// frozen app's components/session/session-inbox-menu.tsx.
//
// This is the LONG TAIL. The one gesture the inbox is actually for — retiring a
// session — sits on the row itself; what is left here is everything that does
// not earn permanent space beside every title.
//
// THE DONOR'S MENU WAS LONGER, AND MOST OF IT NOW HAS SOMETHING TO CALL. This
// file used to say settle, unsettle, snooze and wake were transitions on state
// the vNext engine did not model; `Session.settledOverride` and `snoozedUntil`
// exist now, so they are here. Mark read/unread still is not — `readAt` remains
// unmodelled, and a chip counting a number nothing backs is worse than no chip.
//
// ARCHIVING IS STILL ONE-WAY: the engine removes the session's worktree on the
// way out (apps/engine/src/state.ts), so there is no "Restore" to offer. That
// is exactly why settling exists beside it — a reversible way to get a row out
// of the list without ending the conversation behind it.

import { useState } from "react";
import { AlarmClockIcon, ArchiveIcon, CircleCheckIcon, MoreHorizontalIcon, PencilIcon, PinIcon, PinOffIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SidebarSession } from "@/lib/session-list";
import { canSnooze, isSnoozed, snoozePresets, wakeLabel, type SessionActivity } from "@/lib/session-settling";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";

/** One PATCH, one shape. Both verbs are the same call with different fields,
 *  which is what keeps "settle" and "snooze" from drifting into two protocols. */
export async function patchSession(sessionId: string, patch: { settledOverride?: "settled" | "active" | null; snoozedUntil?: number | null }): Promise<void> {
  await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export function SessionInboxMenu({
  session,
  settled,
  active = false,
  onRename,
  onDone,
  onLeave,
  className,
  activity = {},
  now,
}: {
  session: SidebarSession;
  /** Whether the row currently sits in the settled shelf, for either reason. */
  settled: boolean;
  /** What the list knows about this session right now. Empty is the honest
   *  default: the sidebar does not hold a live turn state per row. */
  activity?: SessionActivity;
  /** ONE STAMP FOR THE WHOLE LIST, passed in rather than read here. Every row
   *  reading its own `Date.now()` mid-render makes the component impure and
   *  gives two rows different ideas of "now" in the same paint. */
  now: number;
  /**
   * Whether this row is the session currently open in the main view. Archiving
   * THAT session must hand the reader somewhere else rather than leave them on
   * a view whose row just left "Recent".
   */
  active?: boolean;
  /** Switches the row into its inline editor. The row owns that state. */
  onRename?: () => void;
  onDone?: () => void;
  onLeave?: () => void;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const snoozing = isSnoozed(session, activity, { now });

  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } finally {
      onDone?.();
      setBusy(false);
    }
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Session actions"
            title="Session actions"
            disabled={busy}
            // No click guard here on purpose: this button is a SIBLING of the
            // row's <Link>, not a child of it, so a click cannot navigate. A
            // preventDefault would only risk suppressing the menu's own open.
            className={cn("text-muted-foreground hover:text-foreground", className)}
          />
        }
      >
        {busy ? <Spinner className="size-3" /> : <MoreHorizontalIcon />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        {onRename ? (
          <DropdownMenuItem disabled={session.archived} onClick={onRename}>
            <PencilIcon />
            Rename
          </DropdownMenuItem>
        ) : null}

        {!session.archived && (
          <>
            <DropdownMenuSeparator />
            {/**
             * THE PIN, WHICH IS THE HALF PEOPLE FORGET TO BUILD. Settling gets
             * a row out of the way; this keeps one the clock would otherwise
             * take away. Without it, a long-running piece of work you have not
             * touched this week silently leaves the list, and the only way back
             * is to remember it exists.
             */}
            {session.settledOverride === "active" ? (
              <DropdownMenuItem onClick={() => void run(() => patchSession(session.id, { settledOverride: null }))}>
                <PinOffIcon />
                Stop keeping in the list
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onClick={() => void run(() => patchSession(session.id, { settledOverride: "active" }))}>
                <PinIcon />
                Keep in the list
              </DropdownMenuItem>
            )}

            {snoozing ? (
              <DropdownMenuItem onClick={() => void run(() => patchSession(session.id, { snoozedUntil: null }))}>
                <AlarmClockIcon />
                {`Wake now — sleeping ${wakeLabel(session.snoozedUntil!, now)}`}
              </DropdownMenuItem>
            ) : (
              <DropdownMenuGroup>
                <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  Snooze until
                </DropdownMenuLabel>
                {/* Presets rather than a picker: the point of a snooze is that
                    it costs one gesture. A date field would cost four and be
                    used once. */}
                {snoozePresets(new Date(now)).map((preset) => (
                  <DropdownMenuItem
                    key={preset.id}
                    disabled={!canSnooze(activity)}
                    onClick={() => void run(() => patchSession(session.id, { snoozedUntil: preset.until }))}
                  >
                    <AlarmClockIcon />
                    <span className="flex-1">{preset.label}</span>
                    <span className="text-xs text-muted-foreground">{preset.when}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            )}
          </>
        )}

        <DropdownMenuSeparator />

        {session.archived ? (
          <DropdownMenuItem disabled>
            <CircleCheckIcon />
            Archived
          </DropdownMenuItem>
        ) : settled ? (
          // Shelved by neglect rather than by decision: the row is already out
          // of the way, so archiving it is still offered — it is what actually
          // frees the worktree — but the label says which state it is in.
          <DropdownMenuItem
            onClick={() => {
              if (!window.confirm(`Archive "${session.title || "Untitled session"}"? Its worktree is removed; the branch survives.`)) return;
              void run(() => fetch(`/api/sessions/${encodeURIComponent(session.id)}/archive`, { method: "POST" })).then(() => {
                if (active) onLeave?.();
              });
            }}
          >
            <ArchiveIcon />
            Archive — quiet for 3 days
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            onClick={() => {
              // Archiving ends the session and removes its worktree. Nothing in
              // this menu undoes it, so it asks first.
              if (!window.confirm(`Archive "${session.title || "Untitled session"}"? Its worktree is removed; the branch survives.`)) return;
              void run(() => fetch(`/api/sessions/${encodeURIComponent(session.id)}/archive`, { method: "POST" })).then(() => {
                if (active) onLeave?.();
              });
            }}
          >
            <ArchiveIcon />
            Archive
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
