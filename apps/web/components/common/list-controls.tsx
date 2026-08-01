"use client";

// Search-first index building blocks shared by the dashboard command center and
// the Projects / Looms indexes. Ported from the approved demo-gallery lists
// spec (lib/demo-gallery/lists/shared.tsx) into production: same token language
// (bg-card, border-border, mono tabular numbers) so every dense index reads as
// one system. State-rail color lives in components/looms/utils (stateRailClass)
// — the single source every surface reads off.
import type { ReactNode } from "react";
import {
  ChevronRightIcon,
  SearchIcon,
  WorkflowIcon,
  type LucideIcon,
} from "lucide-react";
import type { Loom } from "@telar/core";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { loomRole, threadCount } from "@/components/looms/utils";

// The index grouping vocabulary — running / needsYou / recent — now lives in
// lib/project-signal, which owns the whole partition and is pure enough to
// test. Re-exported here because it is what an index imports alongside the
// controls it groups with, and because a "use client" file cannot be the home
// of a model that a lib module has to read.
export { isLoomNeedsYou, isLoomRecent, isLoomRunning } from "@/lib/project-signal";

// Search-first field — the header element that anchors every redesigned index.
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
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-9 w-full rounded-lg border border-border bg-background/60 pr-4 pl-9 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:bg-background focus:ring-2 focus:ring-ring/30"
      />
    </div>
  );
}

// A pill filter/segment. Active uses the primary token; inactive stays a quiet
// outline — the same register as the app's Badge outline variant.
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
        "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground",
      )}
    >
      {children}
      {count != null && (
        <span
          className={cn(
            "font-mono tabular-nums",
            active ? "text-primary-foreground/70" : "text-muted-foreground/70",
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}

// Collapsible group header — the sticky band that lets a full index collapse to
// a handful of rows. Chevron rotates on open.
export function GroupHeader({
  icon: Icon,
  label,
  count,
  open,
  onToggle,
  tint,
  action,
}: {
  icon?: LucideIcon;
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  tint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="sticky top-0 z-10 -mx-px flex items-center gap-2 border-b border-border bg-background/95 px-3 py-1.5 text-foreground backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <button
        type="button"
        onClick={onToggle}
        className="flex flex-1 items-center gap-2 text-left"
      >
        <ChevronRightIcon
          className={cn(
            "size-4 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        {Icon && <Icon className={cn("size-4", tint ?? "text-muted-foreground")} />}
        <span className="text-xs font-semibold tracking-wide text-foreground uppercase">
          {label}
        </span>
        <Badge
          variant="outline"
          className="px-1.5 py-0 font-mono text-[10px] text-muted-foreground"
        >
          {count}
        </Badge>
      </button>
      {action}
    </div>
  );
}

// Sort dropdown — native select styled to the token language (no extra dep).
export function SortSelect<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className="h-9 shrink-0 rounded-lg border border-border bg-background/60 px-2.5 text-xs text-foreground outline-none transition-colors hover:bg-muted/40 focus:border-ring focus:ring-2 focus:ring-ring/30"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

// A KPI stat tile for the dashboard hero — above-the-fold priorities so the
// operator never scrolls to learn what needs them. Static (no onClick) renders
// as a plain, non-interactive card.
export function StatTile({
  icon: Icon,
  label,
  value,
  sub,
  tint,
  onClick,
  active,
}: {
  icon: LucideIcon;
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tint?: string;
  onClick?: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={cn(
        "flex flex-col gap-1 rounded-xl border bg-card px-3.5 py-3 text-left text-card-foreground transition-colors",
        onClick && "hover:border-foreground/25",
        active ? "border-primary ring-1 ring-primary/40" : "border-border",
      )}
    >
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className={cn("size-3.5", tint)} />
        <span className="truncate">{label}</span>
      </div>
      <div className="font-mono text-2xl leading-none font-semibold tabular-nums text-foreground">
        {value}
      </div>
      {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
    </button>
  );
}

// An account chip — sky for work, emerald for oss, muted otherwise. Accounts
// are freeform strings (manifest.account), so the tone is by convention, never
// an exhaustive enum.
export function AccountBadge({ account }: { account: string }) {
  const tone =
    account === "work"
      ? "border-sky-500/25 bg-sky-500/5 text-sky-300"
      : account === "oss"
        ? "border-emerald-500/25 bg-emerald-500/5 text-emerald-300"
        : "border-border text-muted-foreground";
  return (
    <Badge variant="outline" className={cn("px-1.5 py-0 text-[10px]", tone)}>
      {account}
    </Badge>
  );
}

// The indigo weave marker — kept OUT of the state palette (matches LoomCard's
// WeaveChip) so a woven loom in needs-review never shows two competing signals.
// Reads role + thread count straight off the loom (no extra fetch); verify
// looms get a quiet outline label, single looms nothing.
export function WeaveChip({ loom }: { loom: Loom }) {
  const role = loomRole(loom);
  if (role === "verify") {
    return (
      <Badge
        variant="outline"
        className="shrink-0 px-1.5 py-0 font-mono text-[10px] text-muted-foreground"
      >
        verify
      </Badge>
    );
  }
  if (role !== "woven") return null;
  const n = threadCount(loom);
  return (
    <Badge
      variant="outline"
      className="shrink-0 gap-1 border-indigo-500/30 bg-indigo-500/10 px-1.5 py-0 font-mono text-[10px] text-indigo-300"
    >
      <WorkflowIcon className="size-2.5" />
      {n == null ? "weave" : `${n} thread${n === 1 ? "" : "s"}`}
    </Badge>
  );
}
