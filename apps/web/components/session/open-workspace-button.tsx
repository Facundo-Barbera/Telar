"use client";

/**
 * "Open with" — the session's workspace folder, in a chosen app.
 *
 * The apps listed are the ones the shell actually found installed
 * (workspace-openers.js); the renderer names an id, never a path. On a remote
 * session, or in a browser tab, the control states why it is unavailable —
 * that beats opening a same-named folder on the wrong machine.
 */
import { useEffect, useState } from "react";
import { ExternalLinkIcon, FolderOpenIcon, SearchIcon } from "lucide-react";
import { workspaceOpenBlocker, workspaceOpener, type WorkspaceOpener } from "@/lib/workspace-open";
import { Button } from "@/components/ui/button";
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
  const bridge = workspaceOpener();
  const blocker = workspaceOpenBlocker({ path, hostId, hostLabel, hasBridge: Boolean(bridge) });

  /** Asked on each open: an editor installed since last time should appear
   *  without a reload. A shell too old to enumerate answers nothing, and the
   *  system default below is still offered. */
  useEffect(() => {
    if (!open || blocker || !bridge?.openers) return;
    let live = true;
    void bridge
      .openers()
      .then((answer) => live && setOpeners(answer.openers))
      .catch(() => live && setOpeners([]));
    return () => {
      live = false;
    };
  }, [open, blocker, bridge]);

  if (!bridge && typeof window !== "undefined" && !(window as { telarDesktop?: unknown }).telarDesktop) return null;

  const act = (run: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(undefined);
    void run()
      .then((result) => {
        if (!result.ok) setError(result.error ?? "That folder could not be opened.");
        else setOpen(false);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "That folder could not be opened."));
  };

  const row = "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/60";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Open workspace" title={blocker ?? "Open this session's folder"}>
            <ExternalLinkIcon />
          </Button>
        }
      />
      <PopoverContent align="end" side="bottom" sideOffset={6} className="max-h-[min(24rem,70vh)] w-72 flex-col gap-0 overflow-y-auto rounded-xl p-1">
        {blocker ? (
          <p className="px-2 py-1.5 text-[0.6875rem] leading-snug text-muted-foreground">{blocker}</p>
        ) : (
          <>
            {openers === undefined ? (
              <p className="px-2 py-1.5 text-[0.6875rem] text-muted-foreground">Looking for installed apps…</p>
            ) : (
              openers.map((opener) => (
                <button key={opener.id} type="button" title={opener.path} onClick={() => act(() => bridge!.open(path!, opener.id))} className={row}>
                  <FolderOpenIcon className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{opener.label}</span>
                </button>
              ))
            )}
            {openers?.length === 0 && (
              <p className="px-2 py-1.5 text-[0.6875rem] leading-snug text-muted-foreground">No known editor found in Applications.</p>
            )}
            <div className="my-1 h-px bg-border" />
            <button type="button" onClick={() => act(() => bridge!.open(path!))} className={row}>
              <FolderOpenIcon className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">System default</span>
            </button>
            <button type="button" onClick={() => act(() => bridge!.reveal(path!))} className={row}>
              <SearchIcon className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">Reveal in Finder</span>
            </button>
            <p className="px-2 py-1 font-mono text-[0.625rem] leading-snug break-all text-muted-foreground/80">{path}</p>
          </>
        )}
        {error && <p className="px-2 py-1.5 text-[0.6875rem] leading-snug text-destructive">{error}</p>}
      </PopoverContent>
    </Popover>
  );
}
