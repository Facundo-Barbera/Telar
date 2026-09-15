"use client";

// The per-row action menu for the sidebar's session list — the `⋯` button and,
// since the menu became a definition, the row's right-click menu as well.
//
// WHAT THE MENU CONTAINS NO LONGER LIVES HERE. `lib/session-action-menu.ts`
// holds the list, `session-action-menu.tsx` holds the markup, and this file
// holds what only the rail can answer: which engine a verb lands on, what
// "busy" looks like on a row, and where a deleted row hands the reader next.
// The cockpit header renders the same list from its own record, which is the
// whole point — labels, ordering and gating cannot drift between them.
//
// THE DONOR'S MENU WAS LONGER, AND MOST OF IT NOW HAS SOMETHING TO CALL. This
// file used to say settle, unsettle, snooze and wake were transitions on state
// the engine did not model; `Session.settledOverride` and `snoozedUntil` exist
// now, so they are here.
//
// UNREAD IS MODELLED TOO, and is deliberately still not a menu item. The engine
// records which result a human was shown (`markSessionRead`) and the list uses
// it for one rule — the clock may not shelve an unread answer — so there is a
// number behind it now. A "mark unread" verb is a different feature: it asks
// people to curate a second inbox by hand, and the whole point of deriving this
// from what was actually on screen is that nobody has to.
//
// ARCHIVE IS GONE; THE PAIR IS SETTLE AND DELETE. Archiving and settling were
// two names for "off my list", and keeping both cost a chip, a menu item and a
// lifecycle field to insist they differed. Where they DID differ was the wrong
// way round: archive was the irreversible one and the one that looked
// reversible, because the record survived and the row merely vanished. Settle
// is reversible and touches no disk; delete says what it does and asks twice.
//
// Both of those arguments now guard a wider surface than this file, so
// `lib/session-action-menu.test.ts` asserts neither verb can reappear in the
// one list all three menus render.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MoreHorizontalIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { LOCAL_HOST_ID } from "@/lib/hosts/client";
import { projectSettingsHref } from "@/lib/project-settings-link";
import { canvasHref, sessionKey, type SidebarSession } from "@/lib/session-list";
import {
  deleteSession,
  mutateRow,
  patchSession,
  withSettling,
  withSnooze,
  type SessionRowChange,
  type SessionRowChanged,
} from "@/lib/session-mutations";
import { sessionLink } from "@/lib/session-link";
import { desktopApp } from "@/lib/desktop-app";
import { type SettlingActivity } from "@/lib/session-settling";
import {
  buildSessionActionMenuItems,
  type SessionActionHandlers,
  type SessionActionItem,
  type SessionActionTarget,
} from "@/lib/session-action-menu";

import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { dropdownSessionMenuParts, SessionActionContextMenu, SessionActionMenuItems } from "./session-action-menu";

/**
 * THE RAIL'S PROJECTION, FOLDED INTO WHAT THE MENU READS. Nine fields rather
 * than a cast: `SidebarSession` names this session's branch `worktreeBranch`
 * and carries `projectBranch` beside it — the PROJECT checkout's HEAD, which
 * belongs to every local session in that project and to none of them in
 * particular. Handing that one to an item that says "New session on <branch>"
 * would attribute somebody else's branch to this conversation.
 */
function menuTarget(session: SidebarSession, settled?: boolean): SessionActionTarget {
  return {
    id: session.id,
    title: session.title,
    ...(session.projectId ? { projectId: session.projectId } : {}),
    ...(session.projectName ? { projectName: session.projectName } : {}),
    ...(session.hostId ? { hostId: session.hostId } : {}),
    workspacePath: session.workspacePath,
    ...(session.worktreeBranch ? { branch: session.worktreeBranch } : {}),
    ...(session.settledOverride ? { settledOverride: session.settledOverride } : {}),
    ...(settled === undefined ? {} : { settled }),
    ...(session.snoozedUntil === undefined ? {} : { snoozedUntil: session.snoozedUntil }),
    ...(session.snoozedAt === undefined ? {} : { snoozedAt: session.snoozedAt }),
    archived: session.archived,
    updatedAt: session.updatedAt,
  };
}

export type SessionRowMenuProps = {
  session: SidebarSession;
  /** What the list knows about this session right now — `settlingActivity` in
   *  lib/session-list.ts folds it out of the engine's report. */
  activity?: SettlingActivity;
  /** ONE STAMP FOR THE WHOLE LIST, passed in rather than read here. Every row
   *  reading its own `Date.now()` mid-render makes the component impure and
   *  gives two rows different ideas of "now" in the same paint. */
  now: number;
  /** Off the list right now, by decision OR by the clock — the row already
   *  folds this for its own settle button, and the menu's toggle must agree
   *  with the button beside it. */
  settled?: boolean;
  /**
   * Whether this row is the session currently open in the main view. Deleting
   * THAT session must hand the reader somewhere else rather than leave them on
   * a view whose row has gone.
   */
  active?: boolean;
  /** Switches the row into its inline editor. The row owns that state. */
  onRename?: () => void;
  /**
   * ONE ROW CHANGED, AND HERE IT IS — issue #495. This was `onDone`, a bare
   * "something happened, go and read everything again", and the rail answered
   * it with `loadAll()`: the pairing book plus one live read per paired Mac,
   * per click. Every verb below now hands back the row the engine answered
   * with, and the rail patches that row in place.
   */
  onRowChanged?: SessionRowChanged;
  onLeave?: () => void;
};

/**
 * The rail's answers to the definition's questions: what each verb calls, and
 * on which Mac. Shared by the `⋯` and the right-click menu so the two cannot
 * bind the same label to different behaviour.
 */
function useSessionRowMenu({ session, activity = {}, now, settled, active, onRename, onRowChanged, onLeave }: SessionRowMenuProps): {
  items: SessionActionItem[];
  busy: boolean;
} {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  /**
   * ONE OPTIMISTIC MUTATION, WITH THE SPINNER STILL ON THE `⋯` — issue #495.
   *
   * The row moves before the request is sent (`mutateRow` hands `after` over
   * first), so the busy flag is no longer what tells a person the click landed
   * — it is what stops a second click stacking a second patch on top of the
   * first while the round trip is out.
   *
   * A ROW WITH NO LISTENER STILL WRITES. `onRowChanged` is optional because the
   * cockpit header renders this same definition without a list behind it; the
   * mutation runs either way, and only the repaint is skipped.
   */
  const mutate = async (after: SessionRowChange, send: Parameters<typeof mutateRow>[0]["send"]) => {
    if (busy) return;
    setBusy(true);
    try {
      await mutateRow({ before: session, after, send, onRowChanged: onRowChanged ?? (() => {}) });
    } finally {
      setBusy(false);
    }
  };

  /** The shell, or nothing in a browser tab — which is what decides whether the
   *  menu carries "Open in a new window" at all. */
  const shell = desktopApp();

  const actions: SessionActionHandlers = {
    // The row's own click, as a verb. Same `href` the row's <Link> carries,
    // because the definition hands over `sessionHref`'s answer rather than
    // letting each surface re-derive one.
    open: (href) => router.push(href),
    copyLink: (href) => void copyToClipboard(sessionLink(href)),
    // Absent in a browser tab, and absent on a shell too old to carry it: the
    // handler is what the definition gates the item on.
    ...(shell?.openWindow ? { openWindow: (href: string) => void shell.openWindow!(href) } : {}),
    newSession: ({ projectId, hostId, baseRef }) => router.push(canvasHref(projectId, hostId, baseRef ? { baseRef } : undefined)),
    pin: (pinned) =>
      void mutate({ row: withSettling(session, pinned ? "active" : null) }, () =>
        patchSession(session, { settledOverride: pinned ? "active" : null }),
      ),
    settle: (next) =>
      void mutate({ row: withSettling(session, next ? "settled" : null) }, async () => {
        if (next) return patchSession(session, { settledOverride: "settled" });
        // TWO PATCHES, AND THE FIRST IS NOT A NO-OP. A drift-settled session has
        // no override to clear, and clearing nothing writes nothing — so nothing
        // would change. Setting an override first makes the clearing patch a real
        // change, and a real change stamps `updatedAt`, which is what actually
        // restarts the inactivity clock. Same two-step as the row's own button.
        //
        // THE SECOND ANSWER IS THE ONE THE ROW SETTLES ON (#495): the first is a
        // state nothing should ever draw, and returning it would flash the row
        // through "pinned" on its way back to the list.
        if (session.settledOverride !== "settled") await patchSession(session, { settledOverride: "active" });
        return patchSession(session, { settledOverride: null });
      }),
    snooze: (until) => void mutate({ row: withSnooze(session, until) }, () => patchSession(session, { snoozedUntil: until })),
    rename: () => onRename?.(),
    copy: (text) => void copyToClipboard(text),
    projectSettings: ({ projectId }) => router.push(projectSettingsHref(projectId)),
    remove: () => {
      const name = session.title || "Untitled session";
      // TWO PRESSES, AND THE SECOND ONE NAMES WHAT GOES. The first question is
      // the one people learn to dismiss; the second states the consequence that
      // is not recoverable. The transcript goes with the worktree, and there is
      // no restore anywhere in this app.
      if (!window.confirm(`Delete "${name}"?`)) return;
      if (!window.confirm(`This removes the transcript and the worktree for "${name}". It cannot be undone.`)) return;
      /**
       * THE ROW GOES AT ONCE AND COMES BACK IF THE ENGINE REFUSES — #495.
       *
       * Deleting is the one verb here whose optimistic state is an ABSENCE, so
       * `after` is never drawn: `mutateRow` hands it over, the engine answers
       * nothing, and the change becomes a `removed`. A refusal — a turn in
       * flight is the common one — puts the row back exactly as it was.
       *
       * LEAVING THE VIEW WAITS FOR THE ANSWER. The survivor rule keeps the open
       * session's row visible while the URL names it, so navigating before the
       * delete lands would be navigating away from a conversation that might
       * still be there.
       */
      void mutate({ removed: sessionKey(session) }, () => deleteSession(session)).then(() => {
        if (active) onLeave?.();
      });
    },
  };

  const items = buildSessionActionMenuItems({
    session: menuTarget(session, settled),
    activity,
    now,
    // A row on a paired Mac cannot open that project's settings from here —
    // there is no `/hosts/:id/projects/:id/settings` route, and this Mac's page
    // for the same id would be a different project or none.
    capabilities: {
      remote: Boolean(session.hostId && session.hostId !== LOCAL_HOST_ID),
      // The row the main view is already showing — `Open` says so rather than
      // navigating to where you are.
      current: Boolean(active),
    },
    actions,
  });
  return { items, busy };
}

/** The shim in `lib/clipboard.ts` fills `writeText` in on an origin the browser
 *  does not call secure, so this stays one call. A refusal is still reported —
 *  a copy button that quietly did nothing is the bug that shim exists for. */
async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    window.alert("The browser refused to copy that.");
  }
}

/** The row's right-click menu. Same list as the `⋯` beside it, by construction. */
export function SessionRowContextMenu({ children, ...props }: SessionRowMenuProps & { children: React.ReactNode }) {
  const { items } = useSessionRowMenu(props);
  return <SessionActionContextMenu items={items}>{children}</SessionActionContextMenu>;
}

export function SessionInboxMenu({ className, ...props }: SessionRowMenuProps & { className?: string }) {
  const { items, busy } = useSessionRowMenu(props);
  const [open, setOpen] = useState(false);

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
      <DropdownMenuContent align="end" className="min-w-52">
        <SessionActionMenuItems items={items} parts={dropdownSessionMenuParts} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
