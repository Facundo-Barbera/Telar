"use client";

import { Fragment, useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { ChevronDownIcon, ExternalLinkIcon } from "lucide-react";
import { workspaceOpenBlocker, workspaceOpener, type WorkspaceOpenersAnswer } from "../workspace-open";
import {
  preferredOpenerSnapshot,
  remembersOpener,
  serverPreferredOpenerSnapshot,
  subscribePreferredOpener,
  workspaceOpenerEntries,
  workspaceOpenerPrimary,
  workspaceOpenerPrimaryLabel,
  writePreferredOpener,
  type WorkspaceOpenerEntry,
} from "../workspace-opener-preference";
import { useCommandHandlers, KeyHint } from "@/features/commands/index";
import { OpenerIcon } from "./opener-icon";
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
  const [answer, setAnswer] = useState<WorkspaceOpenersAnswer>();
  const [error, setError] = useState<string>();
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
      .then((found) => live && setAnswer(found))
      .catch(() => live && setAnswer({ openers: [] }));
    return () => {
      live = false;
    };
  }, [blocker, bridge]);

  useEffect(() => refresh(), [refresh]);

  useEffect(() => (open ? refresh() : undefined), [open, refresh]);

  const canReveal = !blocker && Boolean(bridge) && Boolean(path);
  useCommandHandlers(
    canReveal
      ? {
          "reveal-in-finder": () => {
            setError(undefined);
            void bridge!
              .reveal(path!)
              .then((result) => {
                if (result.ok) return;
                setError(result.error ?? "That folder could not be shown.");
                setOpen(true);
              })
              .catch((cause: unknown) => {
                setError(cause instanceof Error ? cause.message : "That folder could not be shown.");
                setOpen(true);
              });
          },
        }
      : {},
    [canReveal],
  );

  if (!bridge && typeof window !== "undefined" && !(window as { telarDesktop?: unknown }).telarDesktop) return null;

  const entries = workspaceOpenerEntries({ openers: answer?.openers ?? [], preferred, revealIconDataUrl: answer?.revealIconDataUrl });
  const primary = answer === undefined ? undefined : workspaceOpenerPrimary(entries);
  const primaryLabel = primary ? workspaceOpenerPrimaryLabel(entries) : "Open";

  const act = (entry: WorkspaceOpenerEntry) => {
    setError(undefined);
    if (remembersOpener(entry)) writePreferredOpener(hostId, entry.id);
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
        <PopoverTrigger
          render={
            <Button type="button" variant="outline" size="icon-sm" aria-label="Open workspace" title={blocker}>
              <ExternalLinkIcon />
            </Button>
          }
        />
      ) : (
        <ButtonGroup>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={primary ? () => act(primary) : () => setOpen(true)}
            title={primary ? `${primaryLabel} — ${path}` : "Open this session's folder"}
            aria-label={primary ? primaryLabel : "Open this session's folder"}
          >
            <OpenerIcon icon={primary?.icon} iconDataUrl={primary?.iconDataUrl} />
            <span>Open</span>
          </Button>
          <ButtonGroupSeparator />
          <PopoverTrigger
            render={
              <Button type="button" variant="outline" size="icon-sm" aria-label="Choose an app to open this folder with">
                <ChevronDownIcon />
              </Button>
            }
          />
        </ButtonGroup>
      )}
      <PopoverContent align="end" side="bottom" sideOffset={6} className="max-h-[min(24rem,70vh)] w-72 flex-col gap-0 overflow-y-auto rounded-xl p-1">
        {blocker ? (
          <p className="px-2 py-1.5 text-2xs leading-snug text-muted-foreground">{blocker}</p>
        ) : answer === undefined ? (
          <p className="px-2 py-1.5 text-2xs text-muted-foreground">Looking for installed apps…</p>
        ) : (
          <>
            {entries.map((entry) => (
              <Fragment key={entry.id}>
                {entry.separatorBefore && <div className="my-1 h-px bg-border" />}
                {entry.kind === "empty" ? (
                  <p className="px-2 py-1.5 text-2xs leading-snug text-muted-foreground">{entry.label}</p>
                ) : (
                  <button type="button" title={entry.path} onClick={() => act(entry)} className={row}>
                    <OpenerIcon icon={entry.icon} iconDataUrl={entry.iconDataUrl} />
                    <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                    {entry.shortcut && <span className="shrink-0 text-2xs tracking-widest text-muted-foreground">{entry.shortcut}</span>}
                    {entry.kind === "reveal" && canReveal && <KeyHint command="reveal-in-finder" />}
                  </button>
                )}
              </Fragment>
            ))}
            <p className="px-2 py-1 font-mono text-3xs leading-snug break-all text-muted-foreground/80">{path}</p>
          </>
        )}
        {error && <p className="px-2 py-1.5 text-2xs leading-snug text-destructive">{error}</p>}
      </PopoverContent>
    </Popover>
  );
}
