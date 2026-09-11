"use client";

/**
 * "Open" — the session's workspace folder, in the app you actually use.
 *
 * A SPLIT BUTTON THAT LEARNS. The left half opens the preferred app in one
 * click and wears its brand mark; the chevron lists every app the shell found.
 * The preference is written on every open (lib/workspace-opener-preference.ts),
 * so this becomes "Open in Zed" the first time you pick Zed and there is no
 * setting anywhere to keep in step with it. Before there is an answer the left
 * half reads "Open" and opens the list, because a button whose label cannot
 * name what it will do should not do it.
 *
 * The apps listed are the ones the shell actually found installed
 * (workspace-openers.js); the renderer names an id, never a path. On a remote
 * session, or in a browser tab, the control states why it is unavailable —
 * that beats opening a same-named folder on the wrong machine.
 *
 * Revealing in Finder is an entry in the same list rather than a control beside
 * it: it answers the same question ("where do I want this folder?"), and it can
 * be the thing you do most, in which case it is what the left half offers.
 */
import { Fragment, useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { ChevronDownIcon, ExternalLinkIcon } from "lucide-react";
import { workspaceOpenBlocker, workspaceOpener, type WorkspaceOpener } from "@/lib/workspace-open";
import {
  preferredOpenerSnapshot,
  serverPreferredOpenerSnapshot,
  subscribePreferredOpener,
  workspaceOpenerEntries,
  workspaceOpenerPrimary,
  workspaceOpenerPrimaryLabel,
  writePreferredOpener,
  type WorkspaceOpenerEntry,
} from "@/lib/workspace-opener-preference";
import { OpenerIcon } from "@/components/session/opener-icon";
import { Button } from "@/components/ui/button";
import { ButtonGroup, ButtonGroupSeparator } from "@/components/ui/button-group";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export function OpenWorkspaceButton({
  path,
  hostId,
  hostLabel,
}: {
  path: string | undefined;
  hostId?: string | undefined;
  hostLabel?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [openers, setOpeners] = useState<WorkspaceOpener[]>();
  const [error, setError] = useState<string>();
  /** The preference lives outside React, so it is READ THROUGH THE STORE rather
   *  than copied into state in an effect: the server has no `localStorage`, and
   *  the server snapshot is what keeps the first client render agreeing with
   *  the markup it produced. */
  const preferred = useSyncExternalStore(
    subscribePreferredOpener,
    useCallback(() => preferredOpenerSnapshot(hostId), [hostId]),
    serverPreferredOpenerSnapshot,
  );
  const bridge = workspaceOpener();
  const blocker = workspaceOpenBlocker({ path, hostId, hostLabel, hasBridge: Boolean(bridge) });

  const refresh = useCallback(() => {
    if (blocker || !bridge?.openers) return undefined;
    let live = true;
    void bridge
      .openers()
      .then((answer) => live && setOpeners(answer.openers))
      .catch(() => live && setOpeners([]));
    return () => {
      live = false;
    };
  }, [blocker, bridge]);

  /** ASKED ON MOUNT, not just on open, because the left half has to NAME the
   *  preferred app and the preference stores only an id — the label and the
   *  mark belong to the shell's list. It is also what re-validates the
   *  preference: an app uninstalled since the last open drops out of the list
   *  and the button quietly goes back to reading "Open". */
  useEffect(() => refresh(), [refresh]);

  /** And again on each open: an editor installed since last time should appear
   *  without a reload. A shell too old to enumerate answers nothing, and the
   *  system default below is still offered. */
  useEffect(() => (open ? refresh() : undefined), [open, refresh]);

  if (!bridge && typeof window !== "undefined" && !(window as { telarDesktop?: unknown }).telarDesktop) return null;

  const entries = workspaceOpenerEntries({ openers: openers ?? [], preferred });
  const primary = openers === undefined ? undefined : workspaceOpenerPrimary(entries);
  const primaryLabel = primary ? workspaceOpenerPrimaryLabel(entries) : "Open";

  const act = (entry: WorkspaceOpenerEntry) => {
    setError(undefined);
    /** WRITTEN BEFORE THE SHELL ANSWERS, and on every open — including the
     *  reveal and the system default. What you reached for is the choice; a
     *  launch that fails for a transient reason should not throw it away, and
     *  one that fails because the app is gone is dropped by the re-validation
     *  above rather than by refusing to store it. */
    writePreferredOpener(hostId, entry.id);
    void (entry.kind === "reveal" ? bridge!.reveal(path!) : bridge!.open(path!, entry.openerId))
      .then((result) => {
        if (!result.ok) setError(result.error ?? "That folder could not be opened.");
        else setOpen(false);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "That folder could not be opened."));
  };

  const row = "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/60";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {blocker ? (
        // Nothing to split when there is nothing to open: one glyph, and the
        // popover says why.
        <PopoverTrigger
          render={
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Open workspace" title={blocker}>
              <ExternalLinkIcon />
            </Button>
          }
        />
      ) : (
        <ButtonGroup>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            // With no preference this half opens the list instead of guessing.
            onClick={primary ? () => act(primary) : () => setOpen(true)}
            title={primary ? `${primaryLabel} — ${path}` : "Open this session's folder"}
          >
            <OpenerIcon icon={primary?.icon} />
            <span className="max-w-40 truncate">{primaryLabel}</span>
          </Button>
          <ButtonGroupSeparator />
          <PopoverTrigger
            render={
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Choose an app to open this folder with">
                <ChevronDownIcon />
              </Button>
            }
          />
        </ButtonGroup>
      )}
      <PopoverContent align="end" side="bottom" sideOffset={6} className="max-h-[min(24rem,70vh)] w-72 flex-col gap-0 overflow-y-auto rounded-xl p-1">
        {blocker ? (
          <p className="px-2 py-1.5 text-[0.6875rem] leading-snug text-muted-foreground">{blocker}</p>
        ) : openers === undefined ? (
          <p className="px-2 py-1.5 text-[0.6875rem] text-muted-foreground">Looking for installed apps…</p>
        ) : (
          <>
            {entries.map((entry) => (
              <Fragment key={entry.id}>
                {entry.separatorBefore && <div className="my-1 h-px bg-border" />}
                {entry.kind === "empty" ? (
                  <p className="px-2 py-1.5 text-[0.6875rem] leading-snug text-muted-foreground">{entry.label}</p>
                ) : (
                  <button type="button" title={entry.path} onClick={() => act(entry)} className={row}>
                    <OpenerIcon icon={entry.icon} />
                    <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                    {/* Only the preferred row can carry one, and nothing binds a
                        chord to opening a workspace today — the whole table is
                        in lib/command-keys.ts — so this renders nothing until
                        something does. */}
                    {entry.shortcut && <span className="shrink-0 text-[0.6875rem] tracking-widest text-muted-foreground">{entry.shortcut}</span>}
                  </button>
                )}
              </Fragment>
            ))}
            <p className="px-2 py-1 font-mono text-[0.625rem] leading-snug break-all text-muted-foreground/80">{path}</p>
          </>
        )}
        {error && <p className="px-2 py-1.5 text-[0.6875rem] leading-snug text-destructive">{error}</p>}
      </PopoverContent>
    </Popover>
  );
}
