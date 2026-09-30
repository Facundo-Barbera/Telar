"use client";

import { ChevronDownIcon } from "lucide-react";
import { SessionRow } from "./session-row";
import { summarizeChildren, type ChildSummary, type FlatEntry } from "./flat-rail";
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

function ChildrenToggle({ summary, count, open, onToggle }: { summary: ChildSummary; count: number; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={open ? `Hide ${summary.label}` : `Show ${summary.label}`}
      title={summary.label}
      onClick={onToggle}
      className="absolute right-6 bottom-2 z-10 flex h-4 items-center gap-0.5 rounded px-1 text-2xs tabular-nums text-sidebar-foreground/45 hover:bg-sidebar-accent hover:text-sidebar-foreground"
    >
      {summary.needsYou > 0 && <span aria-hidden className="size-1.5 rounded-full bg-destructive" />}
      {count}
      <ChevronDownIcon className={cn("size-3 transition-transform", !open && "-rotate-90")} />
    </button>
  );
}

function FlatRow({
  session,
  variant,
  context,
  disclosure,
}: {
  session: SidebarSession;
  variant: "card" | "slim";
  context: RowContext;
  disclosure?: React.ReactNode;
}) {
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
      {...(disclosure === undefined ? {} : { disclosure })}
    />
  );
}

function FlatEntryItem({ entry, open, onToggle, context }: { entry: FlatEntry; open: boolean; onToggle: () => void; context: RowContext }) {
  const summary = entry.children.length > 0 ? summarizeChildren(entry.children, context.activeSessionId) : undefined;
  const shown = open ? entry.children : (summary?.surfaced ?? []);
  const disclosure = summary && <ChildrenToggle summary={summary} count={entry.children.length} open={open} onToggle={onToggle} />;
  return (
    <div>
      <FlatRow session={entry.session} variant="card" context={context} {...(disclosure ? { disclosure } : {})} />
      {shown.length > 0 && (
        <div className="ml-3" role="group" aria-label={`Started from ${entry.session.title || "this session"}`}>
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
