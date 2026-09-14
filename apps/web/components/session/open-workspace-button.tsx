"use client";

/**
 * "Open" — the session's workspace folder, in the app you actually use.
 *
 * A SPLIT BUTTON THAT LEARNS. The left half opens the preferred app in one
 * click and wears its brand mark; the chevron lists every app the shell found.
 * The preference is written on every open (lib/workspace-opener-preference.ts),
 * so this becomes "Open in Zed" the first time you pick Zed and there is no
 * setting anywhere to keep in step with it.
 *
 * BEFORE YOU HAVE PICKED ANYTHING IT REVEALS IN FINDER (#384). It used to guess
 * an editor, and a guess is the one thing this half cannot afford: it launches
 * on a single click, so guessing wrong opens somebody's folder in an
 * application they did not ask for. Finder shows you the folder and decides
 * nothing, and the first pick from the menu replaces it for good — without
 * teaching the button anything on the way back, since revealing is a look
 * rather than an open (`remembersOpener`).
 *
 * The apps listed are the ones the shell actually found installed
 * (workspace-openers.js); the renderer names an id, never a path. On a remote
 * session, or in a browser tab, the control states why it is unavailable —
 * that beats opening a same-named folder on the wrong machine.
 *
 * Revealing in Finder is an entry in the same list rather than a control beside
 * it: it answers the same question ("where do I want this folder?"). ⌘O is the
 * same verb from the keyboard, bound here rather than in the cockpit because
 * this is where the bridge and the path already are.
 */
import { Fragment, useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { ChevronDownIcon, ExternalLinkIcon } from "lucide-react";
import { workspaceOpenBlocker, workspaceOpener, type WorkspaceOpenersAnswer } from "@/lib/workspace-open";
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
} from "@/lib/workspace-opener-preference";
import { useCommandHandlers } from "@/lib/use-command-keys";
import { OpenerIcon } from "@/components/session/opener-icon";
import { Button } from "@/components/ui/button";
import { ButtonGroup, ButtonGroupSeparator } from "@/components/ui/button-group";
import { KeyHint } from "@/components/ui/key-hint";
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
  /** THE WHOLE ANSWER, not just its list: Finder's own icon rides beside the
   *  openers rather than in them (#398), because the reveal row is built by
   *  `workspaceOpenerEntries` rather than by the shell's table. */
  const [answer, setAnswer] = useState<WorkspaceOpenersAnswer>();
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
      .then((found) => live && setAnswer(found))
      .catch(() => live && setAnswer({ openers: [] }));
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
   *  reveal below is still offered. */
  useEffect(() => (open ? refresh() : undefined), [open, refresh]);

  /**
   * ⌘O — REVEAL IN FINDER, the same verb the menu's last row carries.
   *
   * Bound here because this is where the bridge, the path and the refusals
   * already live; the cockpit would have to learn all three to own it. Only
   * while it can actually act, so the chord is silently nothing on a remote
   * session or in a browser tab rather than failing when pressed — which is
   * exactly what `bindCommands` means by a command nobody answers.
   *
   * A failure OPENS THE POPOVER, because that is the only place this control
   * has to say a sentence; a keyboard press that failed invisibly would be
   * worse than one that did nothing.
   */
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
    /** WRITTEN BEFORE THE SHELL ANSWERS, and on every open. What you reached
     *  for is the choice; a launch that fails for a transient reason should not
     *  throw it away, and one that fails because the app is gone is dropped by
     *  the re-validation above rather than by refusing to store it.
     *
     *  EXCEPT A REVEAL, which teaches this button nothing: showing a folder in
     *  Finder is a look, not an open. It is what the half does by DEFAULT, and
     *  a default is what happens before you have said anything — so picking it
     *  from the list, which says nothing, must not undo the editor you chose. */
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
        // Nothing to split when there is nothing to open: one glyph, and the
        // popover says why.
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
            // Only the second branch's cause is left now: the shell's list has
            // not arrived, so there is nothing to name and this half shows the
            // list instead of acting.
            onClick={primary ? () => act(primary) : () => setOpen(true)}
            title={primary ? `${primaryLabel} — ${path}` : "Open this session's folder"}
            // THE MARK NAMES THE APP; THE WORD NAMES THE VERB. Spelling both out
            // ("Open in Visual Studio Code") says the app twice — once in the
            // logo everyone recognises and once in a phrase wide enough to eat
            // the session title beside it, since the title is what gives up
            // width in this header. So the half is compact and the full promise
            // lives where there is room for it: the tooltip, the menu row, and
            // the accessible name, which is the one place the logo says nothing.
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
          <p className="px-2 py-1.5 text-[0.6875rem] leading-snug text-muted-foreground">{blocker}</p>
        ) : answer === undefined ? (
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
                    <OpenerIcon icon={entry.icon} iconDataUrl={entry.iconDataUrl} />
                    <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                    {/* Only the PREFERRED row can carry one, and the chord this
                        control has (⌘O, on the reveal row) is not that row — so
                        nothing is handed down and this renders nothing. */}
                    {entry.shortcut && <span className="shrink-0 text-[0.6875rem] tracking-widest text-muted-foreground">{entry.shortcut}</span>}
                    {/* ⌘O WHERE ⌘O ACTUALLY GOES — issue #401. The chord is
                        bound above, on this control, and it reveals: so the cap
                        rides the REVEAL row while ⌘ is held rather than the Open
                        half, which launches whichever editor you last picked.
                        Settings › Keybindings taught this and nothing else did.
                        Absent when the command is unbound, and absent when this
                        control cannot act — `canReveal` is the same condition
                        that decides whether the key does anything at all. */}
                    {entry.kind === "reveal" && canReveal && <KeyHint command="reveal-in-finder" />}
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
