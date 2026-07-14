"use client";

// LANE: lists — shared building blocks for the three index-surface redesigns.
// Everything here matches the live visual language (tokens, StateBadge color
// vocabulary, rounded-xl border cards, mono tabular numbers) so the redesigns
// read as the same system, just denser and search-first (concern 2 + 5).
import type { ReactNode } from "react";
import {
  ChevronRightIcon,
  SearchIcon,
  WorkflowIcon,
  type LucideIcon,
} from "lucide-react";
import type { WorkUnitState } from "@telar/core";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import type { LoomRole } from "./fixtures";

// The state rail color vocabulary (copied from components/looms/utils so the
// demo never imports engine code): sky=running, violet=verifying, emerald=ready,
// primary=done, amber=needs-review/charter, orange=blocked, destructive=failed.
export function railClass(state: WorkUnitState): string {
  switch (state) {
    case "preparing":
    case "running":
    case "scoping":
      return "bg-sky-400";
    case "verifying":
      return "bg-violet-400";
    case "ready":
      return "bg-emerald-400";
    case "done":
      return "bg-primary";
    case "charter-review":
    case "needs-review":
      return "bg-amber-400";
    case "blocked":
      return "bg-orange-400";
    case "failed":
      return "bg-destructive";
    default:
      return "bg-muted-foreground/40";
  }
}

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
    <div className="relative flex-1">
      <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
      <input
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-9 w-full rounded-lg border border-border bg-background/60 pr-16 pl-9 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:bg-background focus:ring-2 focus:ring-ring/30"
      />
      <kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
        /
      </kbd>
    </div>
  );
}

// A pill filter/segment. Active state uses the primary token, inactive stays a
// quiet outline — same register as the app's Badge outline variant.
export function Chip({
  active,
  onClick,
  children,
  count,
  tone,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  count?: number;
  tone?: "default" | "sky" | "amber" | "emerald";
}) {
  const toneRing =
    tone === "sky"
      ? "before:bg-sky-400"
      : tone === "amber"
        ? "before:bg-amber-400"
        : tone === "emerald"
          ? "before:bg-emerald-400"
          : "";
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors",
        tone && tone !== "default"
          ? "pl-3.5 before:absolute before:left-2 before:size-1.5 before:rounded-full before:content-['']"
          : "",
        toneRing,
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
// a handful of rows (concern 5: kill the scroll). Chevron rotates on open.
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
    <div className="sticky top-0 z-10 -mx-px flex items-center gap-2 border-b border-border bg-background/95 px-3 py-1.5 backdrop-blur supports-[backdrop-filter]:bg-background/80">
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

// A KPI stat tile for the dashboard hero — above-the-fold priorities so the
// operator never scrolls to learn what needs them (concern 5).
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
        "flex flex-col gap-1 rounded-xl border bg-card px-3.5 py-3 text-left transition-colors",
        onClick && "hover:border-foreground/25",
        active ? "border-primary ring-1 ring-primary/40" : "border-border",
      )}
    >
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className={cn("size-3.5", tint)} />
        <span className="truncate">{label}</span>
      </div>
      <div className="font-mono text-2xl leading-none font-semibold tabular-nums">
        {value}
      </div>
      {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
    </button>
  );
}

// The indigo weave marker — kept OUT of the state palette (matches LoomCard's
// WeaveChip) so a woven loom in needs-review never shows two competing signals.
export function WeaveChip({
  role,
  threads,
  threadsDone,
}: {
  role: LoomRole;
  threads: number | null;
  threadsDone?: number;
}) {
  if (role !== "woven") {
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
    return null;
  }
  return (
    <Badge
      variant="outline"
      className="shrink-0 gap-1 border-indigo-500/30 bg-indigo-500/10 px-1.5 py-0 font-mono text-[10px] text-indigo-300"
    >
      <WorkflowIcon className="size-2.5" />
      {threads == null
        ? "weave"
        : threadsDone != null && threadsDone < threads
          ? `${threadsDone}/${threads}`
          : `${threads} thread${threads === 1 ? "" : "s"}`}
    </Badge>
  );
}

// A thin thread-progress bar for a woven loom in flight — indigo, matching the
// weave chip, so scanning a dense list shows how far each weave has woven.
export function ThreadProgress({
  threads,
  threadsDone,
}: {
  threads: number;
  threadsDone: number;
}) {
  const pct = threads === 0 ? 0 : (threadsDone / threads) * 100;
  return (
    <div className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full bg-indigo-400 transition-all"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

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
