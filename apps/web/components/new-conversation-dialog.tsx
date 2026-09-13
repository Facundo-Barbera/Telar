"use client";

/**
 * WHERE DOES THIS CONVERSATION GO — asked once, as a palette.
 *
 * IT REPLACES A DROPDOWN THAT ONLY APPEARED WHEN A MAC WAS PAIRED. The rail's
 * New-conversation button used to be two different controls: a plain button
 * that opened a GUESS, and — only on a cockpit with a paired Mac — a menu of
 * every project on every Mac. So the one affordance that let you say "start
 * this on the mini" was invisible on the machine most people run, and the
 * ordinary case had no way to name a project at all short of navigating to it
 * first. One palette answers both, and it is the same control either way.
 *
 * A PALETTE RATHER THAN A MENU, because the list is as long as somebody's
 * registry and a menu of thirty items is a scroll. Typing narrows it, ⌘1..⌘9
 * take the first nine without the arrows, and the footer says so — a palette
 * whose keys are undiscoverable is a list you click.
 *
 * THE HOST RIDES ON EVERY ROW, not just on remote ones' headings. A reader
 * looking at a list where some rows are local and some are not has to remember
 * which section they scrolled past; naming the Mac on the row it belongs to
 * costs one line of muted text and removes the question.
 *
 * IT OPENS A CANVAS; IT DOES NOT CREATE A SESSION. Same contract the rail's
 * button always had — the first message is what mints the record — so pressing
 * Enter here and changing your mind leaves nothing behind.
 *
 * FOCUS IS THE BROWSER'S, NOT OURS. `autoFocus` is an attribute the browser
 * honours while the element is being inserted; a `.focus()` call after open is
 * what kills the WebKit build this app's browser surfaces run on, which is why
 * `DialogContent` sets `initialFocus={false}` (see ui/dialog.tsx).
 */

import { useMemo, useRef, useState } from "react";
import { MonitorIcon, SearchIcon } from "lucide-react";
import { ProjectAvatar } from "@/components/projects/project-avatar";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/** One destination: a project, and the Mac it is registered on when that Mac
 *  is not this one. `root` is absent for a paired Mac's project — the rail's
 *  aggregate read does not carry it — and the row simply omits the path. */
export type NewConversationTarget = {
  id: string;
  name: string;
  icon?: string;
  /** The glyph somebody picked, which outranks `icon` — see `ProjectAvatar`. */
  iconName?: string;
  hostId?: string;
  hostName?: string;
  root?: string;
};

/** ⌘1..⌘9 reach the first nine ROWS AS FILTERED, which is what makes them
 *  useful with a query typed: the number is the row's place in front of you,
 *  not its place in an unfiltered registry. */
export const QUICK_PICK_LIMIT = 9;

/**
 * Narrow by name, by host, or by path — the three things the row shows, so
 * anything a reader can SEE is something they can type. Case-insensitive, and
 * a blank query is every project rather than none.
 */
export function matchTargets(targets: readonly NewConversationTarget[], query: string): NewConversationTarget[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...targets];
  return targets.filter((target) =>
    [target.name, target.hostName, target.root].some((field) => field?.toLocaleLowerCase().includes(needle)),
  );
}

export function NewConversationDialog({
  open,
  onOpenChange,
  targets,
  onChoose,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targets: readonly NewConversationTarget[];
  onChoose: (target: NewConversationTarget) => void;
}) {
  const [query, setQuery] = useState("");
  const composing = useRef(false);
  const [index, setIndex] = useState(0);
  const matches = useMemo(() => matchTargets(targets, query), [targets, query]);

  /**
   * A FRESH PALETTE EVERY TIME. A query left over from the last open would hide
   * most of the registry from somebody who pressed ⌘N expecting a list.
   *
   * ADJUSTED DURING RENDER rather than in an effect, which is React's own
   * answer for "state derived from a prop change" — an effect here would set
   * state synchronously and cascade a second render, which this app's lint rule
   * refuses on exactly those grounds.
   */
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setQuery("");
      setIndex(0);
    }
  }

  const choose = (target: NewConversationTarget | undefined) => {
    if (!target) return;
    onOpenChange(false);
    onChoose(target);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    // An IME's own Enter commits a candidate; it is not a selection.
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if ((event.metaKey || event.ctrlKey) && /^[1-9]$/.test(event.key)) {
      event.preventDefault();
      choose(matches[Number(event.key) - 1]);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (matches.length === 0) return;
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setIndex((current) => (current + delta + matches.length) % matches.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      choose(matches[index]);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        onKeyDown={onKeyDown}
        className="top-[18%] max-w-lg translate-y-0 gap-0 p-0 sm:max-w-lg"
        aria-label="New conversation"
      >
        {/* The title and the sentence are for a screen reader; the palette's
            own chrome is the field and the list. */}
        <DialogTitle className="sr-only">New conversation</DialogTitle>
        <DialogDescription className="sr-only">Choose the project this conversation belongs to.</DialogDescription>

        <div className="flex items-center gap-2 border-b px-3 py-2.5">
          <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setIndex(0);
            }}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            placeholder="Search projects"
            aria-label="Search projects"
            role="combobox"
            aria-expanded={matches.length > 0}
            aria-controls="new-conversation-results"
            aria-activedescendant={matches[index] ? `new-conversation-${matches[index].id}` : undefined}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>

        <div id="new-conversation-results" role="listbox" aria-label="Projects" className="max-h-80 overflow-y-auto p-1.5">
          {matches.length === 0 && (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">
              {targets.length === 0 ? "No projects registered yet." : "No project matches that."}
            </p>
          )}
          {matches.map((target, at) => {
            const on = at === index;
            return (
              <button
                key={`${target.hostId ?? "local"}:${target.id}`}
                id={`new-conversation-${target.id}`}
                type="button"
                role="option"
                aria-selected={on}
                onClick={() => choose(target)}
                // Pointing at a row makes it the one Enter would take, so the
                // mouse and the arrows never disagree about what is selected.
                onMouseMove={() => setIndex(at)}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors",
                  on ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
                )}
              >
                <ProjectAvatar
                  name={target.name}
                  {...(target.hostId ? {} : { projectId: target.id })}
                  {...(target.icon ? { icon: target.icon } : {})}
                  {...(target.iconName ? { iconName: target.iconName } : {})}
                  size={16}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm">{target.name}</span>
                    {target.hostName && (
                      <span className="flex shrink-0 items-center gap-1 text-[0.6875rem] text-muted-foreground">
                        <MonitorIcon className="size-3" />
                        {target.hostName}
                      </span>
                    )}
                  </span>
                  {target.root && <span className="block truncate font-mono text-[0.6875rem] text-muted-foreground">{target.root}</span>}
                </span>
                {at < QUICK_PICK_LIMIT && (
                  <kbd className="shrink-0 font-sans text-[0.625rem] text-muted-foreground/60">⌘{at + 1}</kbd>
                )}
              </button>
            );
          })}
        </div>

        {/* THE LEGEND IS THE FEATURE. A palette whose keys are undiscoverable
            is a list people click, and the ⌘1..⌘9 on the rows only make sense
            once something says the whole keyboard works here. */}
        <div className="flex items-center gap-4 border-t px-3 py-2 text-[0.6875rem] text-muted-foreground">
          <span>
            <kbd className="font-sans">↑↓</kbd> Navigate
          </span>
          <span>
            <kbd className="font-sans">Enter</kbd> Select
          </span>
          <span>
            <kbd className="font-sans">Esc</kbd> Close
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
