"use client";

import { ChevronRightIcon } from "lucide-react";
import type { SidebarMode } from "@telar/engine-client";
import { SessionRow } from "./session-row";
import { summarizeChildren, type FlatEntry } from "./flat-rail";
import type { RailJumpSlot } from "../session-groups";
import type { SessionRowChanged } from "../session-mutations";
import { sessionKey, type SessionBand, type SidebarSession } from "../session-list";
import { cn } from "@/ui/utils";

type RowContext = {
  activeSessionId?: string;
  renderedAt: number;
  bandFor: (session: SidebarSession) => SessionBand;
  onRowChanged: SessionRowChanged;
  jumpSlot: (key: string) => RailJumpSlot | undefined;
};

function FlatRow({ session, variant, context }: { session: SidebarSession; variant: "card" | "slim"; context: RowContext }) {
  const key = sessionKey(session);
  const slot = context.jumpSlot(key);
  return (
    <SessionRow
      session={session}
      active={key === context.activeSessionId}
      showProject
      variant={variant}
      band={context.bandFor(session)}
      renderedAt={context.renderedAt}
      onRowChanged={context.onRowChanged}
      {...(slot === undefined ? {} : { jumpSlot: slot })}
    />
  );
}

function FlatEntryItem({ entry, open, onToggle, context }: { entry: FlatEntry; open: boolean; onToggle: () => void; context: RowContext }) {
  const summary = entry.children.length > 0 ? summarizeChildren(entry.children, context.activeSessionId) : undefined;
  const shown = open ? entry.children : (summary?.surfaced ?? []);
  return (
    <div>
      <FlatRow session={entry.session} variant="card" context={context} />
      {summary && (
        <div className="ml-3" role="group" aria-label={`Started from ${entry.session.title || "this session"}`}>
          <button
            type="button"
            aria-expanded={open}
            onClick={onToggle}
            className="flex min-w-0 items-center gap-1 rounded px-2 py-0.5 text-left text-3xs text-sidebar-foreground/40 hover:text-sidebar-foreground/80"
          >
            <ChevronRightIcon className={cn("size-2.5 shrink-0 transition-transform", open && "rotate-90")} />
            {summary.needsYou > 0 && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-destructive" />}
            <span className="min-w-0 truncate tabular-nums">{summary.label}</span>
          </button>
          {shown.map((child) => (
            <FlatRow key={sessionKey(child)} session={child} variant="slim" context={context} />
          ))}
        </div>
      )}
    </div>
  );
}

export function FlatSessionList({
  entries,
  expanded,
  onToggle,
  ...context
}: RowContext & {
  entries: readonly FlatEntry[];
  expanded: ReadonlySet<string>;
  onToggle: (key: string) => void;
}) {
  const pinnedCount = entries.filter((entry) => entry.pinned).length;
  return (
    <div className="space-y-0.5">
      {entries.map((entry, index) => {
        const key = sessionKey(entry.session);
        return (
          <div key={key}>
            <FlatEntryItem entry={entry} open={expanded.has(key)} onToggle={() => onToggle(key)} context={context} />
            {index === pinnedCount - 1 && index < entries.length - 1 && <div aria-hidden className="mx-2 mt-1.5 h-px bg-sidebar-border" />}
          </div>
        );
      })}
    </div>
  );
}

export function RailModeSwitch({ mode, onChange }: { mode: SidebarMode; onChange: (next: SidebarMode) => void }) {
  const option = (value: SidebarMode, label: string, title: string) => (
    <button
      type="button"
      aria-pressed={mode === value}
      title={title}
      onClick={() => mode !== value && onChange(value)}
      className={cn(
        "rounded px-1.5 py-0.5 text-2xs leading-4",
        mode === value ? "bg-sidebar-accent text-sidebar-foreground" : "text-sidebar-foreground/55 hover:text-sidebar-foreground",
      )}
    >
      {label}
    </button>
  );
  return (
    <div role="group" aria-label="Group by" className="app-no-drag flex shrink-0 items-center gap-1">
      <span className="hidden text-2xs text-sidebar-foreground/45 @[15rem]/rail-header:inline">Group by</span>
      <div className="flex items-center rounded-md border border-sidebar-border/60 p-px">
        {option("grouped", "Project", "Group conversations under their project.")}
        {option("flat", "None", "One list, newest first, with spawned conversations under their parent.")}
      </div>
    </div>
  );
}
