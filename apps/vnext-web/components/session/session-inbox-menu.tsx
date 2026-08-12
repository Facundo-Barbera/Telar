"use client";

// The per-row overflow menu for the sidebar's session list. Ported from the
// frozen app's components/session/session-inbox-menu.tsx.
//
// This is the LONG TAIL. The one gesture the inbox is actually for — retiring a
// session — sits on the row itself; what is left here is everything that does
// not earn permanent space beside every title.
//
// THE DONOR'S MENU WAS LONGER, AND MOST OF IT HAS NOTHING TO CALL. Settle,
// unsettle, snooze, wake, mark read/unread, restore and delete were all
// transitions on legacy per-session state that the vNext engine does not model,
// and `archiveSession` is the only one of them with an endpoint. Archiving is
// also ONE-WAY here: the engine removes the session's worktree on the way out
// (apps/engine/src/state.ts), so there is no "Restore" to offer.

import { useState } from "react";
import { ArchiveIcon, CircleCheckIcon, MoreHorizontalIcon, PencilIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SidebarSession } from "@/lib/session-list";
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
  active = false,
  onRename,
  onDone,
  onLeave,
  className,
}: {
  session: SidebarSession;
  /** Whether the row currently sits in the settled shelf, for either reason. */
  settled: boolean;
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
