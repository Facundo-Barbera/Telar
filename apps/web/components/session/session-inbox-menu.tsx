"use client";

// The per-row inbox menu for the sidebar's session list.
//
// Everything here is a state transition on ONE session: rest it, defer it to a
// wall-clock time, change whether it reads as unread, archive it, delete it.
// The transitions themselves live in lib/store.ts (which owns the precedence
// rules — settling clears a snooze, snoozing unsettles); this component only
// names them and calls the API, so the two can never drift into disagreeing
// about, say, whether a snoozed row is also settled.
//
// This is the OVERFLOW menu — the long tail. The two gestures an inbox is
// actually for, settling and snoozing, sit on the row itself; what is left
// here is everything that does not earn permanent space beside every title.

import { useState } from "react";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CircleCheckIcon,
  MailIcon,
  MailOpenIcon,
  MoreHorizontalIcon,
  PencilIcon,
  Trash2Icon,
  UndoIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { deleteChat, patchChat } from "@/lib/chat-actions";
import { isUnread, type SidebarSession } from "@/lib/session-list";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";

export function SessionInboxMenu({
  session,
  settled,
  snoozed,
  onRename,
  onDone,
  className,
}: {
  session: SidebarSession;
  /** Whether the row currently sits in the settled shelf, for either reason. */
  settled: boolean;
  /**
   * Whether the row is currently deferred. Passed in rather than recomputed
   * from Date.now() here: the sidebar renders against ONE shared clock
   * (app-sidebar's `renderedAt`) so server and client agree, and reading the
   * real clock during render is both a hydration hazard and impure.
   */
  snoozed: boolean;
  /** Switches the row into its inline editor. The row owns that state. */
  onRename?: () => void;
  onDone?: () => void;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const unread = isUnread(session);

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

  // Settling is explicit, but a row can also be shelved by the derived
  // three-day-quiet rule with no settledAt of its own. "Unsettle" on one of
  // those has nothing to clear — so it is offered only when there is a real
  // flag to remove, and the derived case says so in its own label instead.
  const canUnsettle = session.settledAt !== undefined || session.archived;

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
        {settled ? (
          canUnsettle ? (
            <DropdownMenuItem
              onClick={() =>
                void run(async () => {
                  if (session.archived) await patchChat(session.id, { archived: false });
                  if (session.settledAt !== undefined) {
                    await patchChat(session.id, { settled: false });
                  }
                })
              }
            >
              <UndoIcon />
              Unsettle
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem disabled>
              <CircleCheckIcon />
              Settled — quiet for 3 days
            </DropdownMenuItem>
          )
        ) : (
          <DropdownMenuItem
            onClick={() => void run(() => patchChat(session.id, { settled: true }))}
          >
            <CircleCheckIcon />
            Settle
          </DropdownMenuItem>
        )}

        {/* Snooze itself lives on the row (SnoozeMenu) — only its inverse is
            here, because waking a row you can see is rare enough not to earn
            permanent space beside every title. */}
        {snoozed ? (
          <DropdownMenuItem
            onClick={() => void run(() => patchChat(session.id, { snoozeUntil: null }))}
          >
            <UndoIcon />
            Wake now
          </DropdownMenuItem>
        ) : null}

        <DropdownMenuSeparator />

        {onRename ? (
          <DropdownMenuItem onClick={onRename}>
            <PencilIcon />
            Rename
          </DropdownMenuItem>
        ) : null}

        <DropdownMenuItem
          onClick={() => void run(() => patchChat(session.id, { read: unread }))}
        >
          {unread ? <MailOpenIcon /> : <MailIcon />}
          {unread ? "Mark as read" : "Mark as unread"}
        </DropdownMenuItem>

        <DropdownMenuItem
          onClick={() =>
            void run(() => patchChat(session.id, { archived: !session.archived }))
          }
        >
          {session.archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
          {session.archived ? "Restore" : "Archive"}
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem
          variant="destructive"
          onClick={() => {
            // Deleting a session drops its whole transcript, and nothing here
            // undoes it — the one action in this menu that is not a reversible
            // change of band.
            if (
              !window.confirm(
                `Delete "${session.title || "Untitled session"}"? Its transcript is removed for good.`,
              )
            ) {
              return;
            }
            void run(() => deleteChat(session.id));
          }}
        >
          <Trash2Icon />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
