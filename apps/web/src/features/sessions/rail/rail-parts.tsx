import { ChevronRightIcon } from "lucide-react";
import type { SidebarMode } from "@telar/engine-client";
import { RailModeSwitch } from "@/components/session/flat-session-list";
import { KeyHint } from "@/components/ui/key-hint";
import { SidebarGroup, SidebarGroupContent, SidebarHeader, SidebarTrigger } from "@/components/ui/sidebar";
import { CAPTION } from "@/lib/idiom";
import { sessionKey, type SessionBand, type SidebarSession } from "@/lib/session-list";
import type { SessionRowChanged } from "@/lib/session-mutations";
import type { RailJumpSlot } from "@/lib/session-groups";
import { cn } from "@/lib/utils";
import { SessionRow } from "./session-row";

export type RowEnv = {
  activeSessionId?: string;
  renderedAt: number;
  bandFor: (session: SidebarSession) => SessionBand;
  onRowChanged: SessionRowChanged;
  jumpSlotFor: (key: string) => RailJumpSlot | undefined;
};

export function jumpProp(env: RowEnv, key: string): { jumpSlot?: RailJumpSlot } {
  const slot = env.jumpSlotFor(key);
  return slot === undefined ? {} : { jumpSlot: slot };
}

export function TelarSidebarHeader({ mode, onModeChange }: { mode: SidebarMode; onModeChange: (next: SidebarMode) => void }) {
  return (
    <SidebarHeader className="app-drag h-[var(--titlebar-height)] justify-center rounded-t-lg border-b border-sidebar-border/60 py-0 pr-2 pl-[max(8px,var(--titlebar-inset))] md:h-[var(--titlebar-band-height)]">
      <div className="flex min-w-0 items-center gap-1">
        <SidebarTrigger aria-label="Hide sidebar" title="Hide sidebar" className="app-no-drag shrink-0" />
        <KeyHint command="toggle-rail" />
        <span className="px-1.5 font-heading text-lg font-semibold tracking-tight">Telar</span>
        <span className="ml-auto" />
        <RailModeSwitch mode={mode} onChange={onModeChange} />
      </div>
    </SidebarHeader>
  );
}

export function SidebarEmpty({
  icon: Icon,
  title,
  detail,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  detail: string;
}) {
  return (
    <div className="px-3 py-6 text-center text-sidebar-foreground/55">
      <Icon className="mx-auto mb-2 size-5" />
      <p className="text-xs font-medium text-sidebar-foreground/75">{title}</p>
      <p className="mt-1 text-2xs leading-4">{detail}</p>
    </div>
  );
}

function BandRule({ label, count, open, onToggle }: { label: string; count: number; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 px-2 py-1.5 text-sidebar-foreground/45 hover:text-sidebar-foreground"
      aria-expanded={open}
      onClick={onToggle}
    >
      <ChevronRightIcon className={`size-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
      <span className={cn("shrink-0", CAPTION)}>{label}</span>
      <span aria-hidden className="h-px flex-1 bg-sidebar-border" />
      <span className="shrink-0 tabular-nums text-2xs">{count}</span>
    </button>
  );
}

export function SessionShelf({
  label,
  count,
  rows,
  open,
  onToggle,
  hasMore,
  onShowMore,
  limit,
  activeSessionId,
  renderedAt,
  bandFor,
  onRowChanged,
}: {
  label: string;
  count: number;
  rows: SidebarSession[];
  open: boolean;
  onToggle: () => void;
  hasMore?: boolean;
  onShowMore?: () => void;
  limit?: number;
  activeSessionId?: string;
  renderedAt: number;
  bandFor: (session: SidebarSession) => SessionBand;
  onRowChanged: SessionRowChanged;
}) {
  if (count === 0) return null;
  return (
    <SidebarGroup className="pt-0">
      <BandRule label={label} count={count} open={open} onToggle={onToggle} />
      {open && (
        <SidebarGroupContent className="space-y-0.5">
          {(limit === undefined ? rows : rows.slice(0, limit)).map((session) => (
            <SessionRow
              key={sessionKey(session)}
              session={session}
              active={sessionKey(session) === activeSessionId}
              showProject
              variant="slim"
              band={bandFor(session)}
              renderedAt={renderedAt}
              onRowChanged={onRowChanged}
            />
          ))}
          {hasMore && onShowMore && (
            <button
              type="button"
              className="w-full rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
              onClick={onShowMore}
            >
              Show more
            </button>
          )}
        </SidebarGroupContent>
      )}
    </SidebarGroup>
  );
}
