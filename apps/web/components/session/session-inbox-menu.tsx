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

import { useState } from "react";
import { AlarmClockIcon, MoreHorizontalIcon, PencilIcon, PinIcon, PinOffIcon, Trash2Icon } from "lucide-react";
import { cn } from "@/lib/utils";
import { hostFetcher, LOCAL_HOST_ID } from "@/lib/hosts/client";
import type { SidebarSession } from "@/lib/session-list";
import { canSnooze, isSnoozed, snoozePresets, wakeLabel, type SettlingActivity } from "@/lib/session-settling";

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

export function SessionInboxMenu({
  session,
  active = false,
  onRename,
  onDone,
  onLeave,
  className,
  activity = {},
  now,
}: {
  session: SidebarSession;
  /** What the list knows about this session right now — `settlingActivity` in
   *  lib/session-list.ts folds it out of the engine's report. */
  activity?: SettlingActivity;
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
              <DropdownMenuItem onClick={() => void run(() => patchSession(session,{ settledOverride: null }))}>
                <PinOffIcon />
                Unpin
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onClick={() => void run(() => patchSession(session,{ settledOverride: "active" }))}>
                <PinIcon />
                Pin to the list
              </DropdownMenuItem>
            )}

            {snoozing ? (
              <DropdownMenuItem onClick={() => void run(() => patchSession(session,{ snoozedUntil: null }))}>
                <AlarmClockIcon />
                <span className="flex-1">Wake now</span>
                <span className="text-xs text-muted-foreground">{wakeLabel(session.snoozedUntil!, now)}</span>
              </DropdownMenuItem>
            ) : (
              <DropdownMenuGroup>
                <DropdownMenuLabel className="text-[0.625rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  Snooze until
                </DropdownMenuLabel>
                {/* Presets rather than a picker: the point of a snooze is that
                    it costs one gesture. A date field would cost four and be
                    used once. */}
                {snoozePresets(new Date(now)).map((preset) => (
                  <DropdownMenuItem
                    key={preset.id}
                    disabled={!canSnooze(activity)}
                    onClick={() => void run(() => patchSession(session,{ snoozedUntil: preset.until }))}
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

        {/**
         * DELETE, WHERE ARCHIVE WAS — and archive is gone rather than demoted.
         *
         * Archiving and settling were two names for "off my list", and keeping
         * both cost a chip, a menu item and a lifecycle field to insist they
         * differed. They did differ in one respect nobody wanted: archive was
         * the irreversible one, and it was the one that LOOKED reversible,
         * because the record survived and the row simply vanished.
         *
         * So the pair is settle and delete now. Settle is reversible and does
         * nothing to disk. Delete says exactly what it does and asks twice: the
         * transcript goes with the worktree, and there is no restore anywhere
         * in this app.
         *
         * A SESSION ARCHIVED BEFORE THIS still exists on disk and now appears in
         * the settled shelf (see `isSettled`), which is where it always
         * belonged — so the eleven of them are readable and deletable rather
         * than stranded behind a chip that no longer exists.
         */}
        <DropdownMenuItem
          variant="destructive"
          onClick={() => {
            const name = session.title || "Untitled session";
            // TWO PRESSES, AND THE SECOND ONE NAMES WHAT GOES. The first
            // question is the one people learn to dismiss; the second states
            // the consequence that is not recoverable.
            if (!window.confirm(`Delete "${name}"?`)) return;
            if (!window.confirm(`This removes the transcript and the worktree for "${name}". It cannot be undone.`)) return;
            void run(() => sessionFetch(session, `/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" })).then(() => {
              if (active) onLeave?.();
            });
          }}
        >
          <Trash2Icon />
          Delete session
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
