"use client";

/**
 * The rail's flat mode, drawn: every conversation a card with its project on
 * the card's first line, pinned first, and spawned conversations folded under
 * their parent behind one summary line. See `lib/flat-rail.ts` for the rules.
 *
 * ONLY THE TOKENS THE REST OF THE RAIL ALREADY PAINTS WITH — sidebar-foreground
 * at the shelf rules' opacities, sidebar-border, sidebar-accent and destructive
 * — so every Look that draws the grouped rail draws this one, light and dark.
 */
import { ChevronRightIcon } from "lucide-react";
import type { SidebarMode } from "@telar/engine-client";
import { SessionRow } from "@/features/sessions";
import { summarizeChildren, type FlatEntry } from "@/lib/flat-rail";
import type { RailJumpSlot } from "@/lib/session-groups";
import type { SessionRowChanged } from "@/lib/session-mutations";
import { sessionKey, type SessionBand, type SidebarSession } from "@/lib/session-list";
import { cn } from "@/lib/utils";

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
        <div className="ml-4 space-y-0.5 border-l border-sidebar-border pl-1.5" role="group" aria-label={`Started from ${entry.session.title || "this session"}`}>
          <button
            type="button"
            aria-expanded={open}
            onClick={onToggle}
            className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-left text-2xs text-sidebar-foreground/55 hover:bg-sidebar-accent hover:text-sidebar-foreground"
          >
            <ChevronRightIcon className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
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
            {/* The same unworded rule the grouped rail draws under its pinned band. */}
            {index === pinnedCount - 1 && index < entries.length - 1 && <div aria-hidden className="mx-2 mt-1.5 h-px bg-sidebar-border" />}
          </div>
        );
      })}
    </div>
  );
}

/** "Group by: Project | None" — the rail header's mode switch. */
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
      <span className="text-2xs text-sidebar-foreground/45">Group by</span>
      <div className="flex items-center rounded-md border border-sidebar-border/60 p-px">
        {option("grouped", "Project", "Group conversations under their project.")}
        {option("flat", "None", "One list, newest first, with spawned conversations under their parent.")}
      </div>
    </div>
  );
}
