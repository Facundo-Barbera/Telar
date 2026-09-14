"use client";

/**
 * The three controls a dense grouped list is built from — ported from
 * `apps/web_old/components/common/list-controls.tsx` (its search field, filter
 * chip and collapsible group header; the donor's other exports are not used
 * here and were not brought over).
 *
 * SHARED SO EVERY LIST IN THE APP READS AS ONE SYSTEM. The queue is
 * described in `ui-contract.md` as "the app's proven list idiom: search-first
 * toolbar, lane filter chips, collapsible groups, dense rows" — proven meaning
 * these, rather than a shape invented for it.
 */
import type { ReactNode } from "react";
import { ChevronRightIcon, SearchIcon, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function SearchField({
  value,
  onChange,
  placeholder,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  autoFocus?: boolean;
}) {
  return (
    <div className="relative min-w-0 flex-1">
      <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
      <input
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-9 w-full rounded-lg border border-border bg-background/60 pr-4 pl-9 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:bg-background focus:ring-2 focus:ring-ring/30"
      />
    </div>
  );
}

/** A filter chip with an optional count. The count is what lets a chip answer
 *  "how many will I see if I click this" rather than merely naming a filter. */
export function Chip({
  active,
  onClick,
  children,
  count,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  count?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground",
      )}
    >
      {children}
      {count != null && (
        <span className={cn("font-mono tabular-nums", active ? "text-primary-foreground/70" : "text-muted-foreground/70")}>
          {count}
        </span>
      )}
    </button>
  );
}

/**
 * `meta` IS A SEPARATE SLOT FROM `label`, and that split is the fix for a real
 * defect rather than a nicety. The label is UPPERCASED — it is a group name —
 * and a caller with more to say used to have no choice but to concatenate it in,
 * which shouted a whole sentence and then truncated it. Anything that is not the
 * group's NAME belongs here: it renders right-aligned, in normal case, and it
 * shrinks before the name does.
 */
export function GroupHeader({
  icon: Icon,
  label,
  count,
  open,
  onToggle,
  tint,
  meta,
  action,
}: {
  icon?: LucideIcon;
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  tint?: string;
  meta?: ReactNode;
  action?: ReactNode;
}) {
  return (
    /* `app-ground`: a section header is the panel's canvas continuing over the
       rows it has scrolled past, so over a backdrop it thins with the panel
       instead of banding across it. Its blur is what keeps the label legible —
       the same trade the cockpit masthead makes. */
    <div className="app-ground sticky top-0 z-10 -mx-px flex items-center gap-2 border-b border-border bg-background/95 px-3 py-1.5 text-foreground backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <button type="button" onClick={onToggle} className="flex min-w-0 shrink-0 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRightIcon className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        {Icon && <Icon className={cn("size-4 shrink-0", tint ?? "text-muted-foreground")} />}
        <span className="truncate text-xs font-semibold tracking-wide text-foreground uppercase">{label}</span>
        <Badge variant="outline" className="shrink-0 px-1.5 py-0 font-mono text-3xs text-muted-foreground">
          {count}
        </Badge>
      </button>
      {meta && <div className="flex min-w-0 flex-1 items-center justify-end gap-2 overflow-hidden">{meta}</div>}
      {!meta && <div className="flex-1" />}
      {action}
    </div>
  );
}
