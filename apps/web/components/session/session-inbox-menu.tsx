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
import { hostFetcher, LOCAL_HOST_ID } from "@/lib/hosts/client";
import { projectSettingsHref } from "@/lib/project-settings-link";
import { canvasHref, type SidebarSession } from "@/lib/session-list";
import { sessionLink } from "@/lib/session-link";
import { desktopApp } from "@/lib/desktop-app";
import { type SettlingActivity } from "@/lib/session-settling";
import {
  buildSessionActionMenuItems,
  type SessionActionHandlers,
  type SessionActionItem,
  type SessionActionTarget,
} from "@/lib/session-action-menu";

/**
 * A ROW'S REQUESTS GO TO THE ROW'S MAC. The rail draws a paired Mac's
 * sessions beside the local ones, and every verb on one of them must land on
 * the engine that owns it. A bare `fetch("/api/sessions/…")` reaches THIS
 * Mac's engine whatever the row says — which is a 404 at best, and at worst
 * settles a local session that happens to share the id.
 */
export function sessionFetch(session: Pick<SidebarSession, "hostId">, path: string, init?: RequestInit): Promise<Response> {
  return hostFetcher(session.hostId ?? LOCAL_HOST_ID)(path, init);
}
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { dropdownSessionMenuParts, SessionActionContextMenu, SessionActionMenuItems } from "./session-action-menu";

/**
 * One PATCH, one shape. Both verbs are the same call with different fields,
 * which is what keeps "settle" and "snooze" from drifting into two protocols.
 *
 * A FAILED PATCH IS A FAILURE NOW. This used to `await` the response and throw
 * the result away, so an engine that refused — or was not there — produced a
 * menu that closed, a row that did not change, and no way to tell "it did
 * nothing" from "it worked and the list has not caught up". Pinning is a
 * decision a person made on purpose; silently losing one is the same class of
 * bug as clearing it on the next turn.
 */
export async function patchSession(
  session: Pick<SidebarSession, "id" | "hostId">,
  patch: { settledOverride?: "settled" | "active" | null; snoozedUntil?: number | null; title?: string },
): Promise<void> {
  const response = await sessionFetch(session, `/api/sessions/${encodeURIComponent(session.id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw new Error(await patchFailureMessage(response));
}

async function patchFailureMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: { message?: string } } | null;
    if (payload?.error?.message) return payload.error.message;
  } catch {
    // A non-JSON body is a proxy or a dead socket; the status is all there is.
  }
  return response.status === 0 ? "The engine is not answering." : `The engine refused (${response.status}).`;
}

/**
 * Run one of these verbs and TELL THE TRUTH ABOUT WHAT HAPPENED.
 *
 * The refresh runs either way, which is the important half: on failure it
 * repaints the row from the engine, so what is on screen is what is stored
 * rather than what was clicked. The alert is the second half, and it is an
 * alert because this rail has no error surface of its own — a toast system
 * introduced for this would be a larger change than the bug. It fires only on
 * a real refusal, so nobody who is not already stuck sees one.
 */
export async function runSessionPatch(action: () => Promise<void>, onRefresh?: () => void): Promise<void> {
  try {
    await action();
  } catch (cause) {
    window.alert(cause instanceof Error ? cause.message : "The engine refused that change.");
  } finally {
    onRefresh?.();
  }
}

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
  onDone?: () => void;
  onLeave?: () => void;
};

/**
 * The rail's answers to the definition's questions: what each verb calls, and
 * on which Mac. Shared by the `⋯` and the right-click menu so the two cannot
 * bind the same label to different behaviour.
 */
function useSessionRowMenu({ session, activity = {}, now, settled, active, onRename, onDone, onLeave }: SessionRowMenuProps): {
  items: SessionActionItem[];
  busy: boolean;
} {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  // `onDone` is the list's refresh, and it runs on the failure path too — see
  // `runSessionPatch`, whose reasoning this shares: after a refusal the row
  // must show what the engine stored, not what the menu item promised.
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } catch (cause) {
      window.alert(cause instanceof Error ? cause.message : "The engine refused that change.");
    } finally {
      onDone?.();
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
    pin: (pinned) => void run(() => patchSession(session, { settledOverride: pinned ? "active" : null })),
    settle: (next) =>
      void run(async () => {
        if (next) {
          await patchSession(session, { settledOverride: "settled" });
          return;
        }
        // TWO PATCHES, AND THE FIRST IS NOT A NO-OP. A drift-settled session has
        // no override to clear, and clearing nothing writes nothing — so nothing
        // would change. Setting an override first makes the clearing patch a real
        // change, and a real change stamps `updatedAt`, which is what actually
        // restarts the inactivity clock. Same two-step as the row's own button.
        if (session.settledOverride !== "settled") await patchSession(session, { settledOverride: "active" });
        await patchSession(session, { settledOverride: null });
      }),
    snooze: (until) => void run(() => patchSession(session, { snoozedUntil: until })),
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
      void run(() => sessionFetch(session, `/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" })).then(() => {
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
