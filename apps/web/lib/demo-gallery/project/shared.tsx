"use client";

// LANE: project (NEW) — shared building blocks for the two project-hub variants.
// Self-contained on purpose: this view was never covered by a redesign lane, so
// it re-declares the small primitives (search, chips, group headers, theme
// frame) in the exact register the approved UI-v2 lanes established — dense
// grouped rows, sticky toolbars, state rails, quiet mono metadata — rather than
// reaching across lane fences. Only StateBadge + fmtAgo/fmtCost are shared prod
// code (same as the lists lane). No `dark:` utilities anywhere: theming is done
// by re-declaring the token set on a wrapper so both themes render in-page.
import {
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  ChevronRightIcon,
  MoonIcon,
  SearchIcon,
  SunIcon,
  WorkflowIcon,
  type LucideIcon,
} from "lucide-react";
import type { WorkUnitState } from "@telar/core";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { StateBadge } from "@/components/common/state-badge";
import { fmtAgo, fmtCost } from "@/lib/format";
import type { DemoLoom, DemoSession } from "./fixtures";

/* ------------------------------------------------------------------ theming */

type Vars = Record<string, string>;

// Token values lifted verbatim from app/globals.css. The app shell hard-codes
// `.dark` on <html>; setting these on a wrapper lets a preview render LIGHT (or
// an explicit DARK island) regardless of the surrounding shell.
const DARK: Vars = {
  "--background": "oklch(0.145 0 0)",
  "--foreground": "oklch(0.985 0 0)",
  "--card": "oklch(0.205 0 0)",
  "--card-foreground": "oklch(0.985 0 0)",
  "--popover": "oklch(0.205 0 0)",
  "--popover-foreground": "oklch(0.985 0 0)",
  "--primary": "oklch(0.922 0 0)",
  "--primary-foreground": "oklch(0.205 0 0)",
  "--secondary": "oklch(0.269 0 0)",
  "--secondary-foreground": "oklch(0.985 0 0)",
  "--muted": "oklch(0.269 0 0)",
  "--muted-foreground": "oklch(0.708 0 0)",
  "--accent": "oklch(0.269 0 0)",
  "--accent-foreground": "oklch(0.985 0 0)",
  "--destructive": "oklch(0.704 0.191 22.216)",
  "--border": "oklch(1 0 0 / 10%)",
  "--input": "oklch(1 0 0 / 15%)",
  "--ring": "oklch(0.556 0 0)",
  // sidebar tokens — so the embedded Settings side-nav (bg-sidebar) themes with
  // the stage instead of inheriting the shell's dark value in a LIGHT island.
  "--sidebar": "oklch(0.205 0 0)",
  "--sidebar-foreground": "oklch(0.985 0 0)",
  "--sidebar-border": "oklch(1 0 0 / 10%)",
};

const LIGHT: Vars = {
  "--background": "oklch(1 0 0)",
  "--foreground": "oklch(0.145 0 0)",
  "--card": "oklch(1 0 0)",
  "--card-foreground": "oklch(0.145 0 0)",
  "--popover": "oklch(1 0 0)",
  "--popover-foreground": "oklch(0.145 0 0)",
  "--primary": "oklch(0.205 0 0)",
  "--primary-foreground": "oklch(0.985 0 0)",
  "--secondary": "oklch(0.97 0 0)",
  "--secondary-foreground": "oklch(0.205 0 0)",
  "--muted": "oklch(0.97 0 0)",
  "--muted-foreground": "oklch(0.556 0 0)",
  "--accent": "oklch(0.97 0 0)",
  "--accent-foreground": "oklch(0.205 0 0)",
  "--destructive": "oklch(0.577 0.245 27.325)",
  "--border": "oklch(0.922 0 0)",
  "--input": "oklch(0.922 0 0)",
  "--ring": "oklch(0.708 0 0)",
  "--sidebar": "oklch(0.985 0 0)",
  "--sidebar-foreground": "oklch(0.145 0 0)",
  "--sidebar-border": "oklch(0.922 0 0)",
};

export type Theme = "dark" | "light";

// A full-height stage: a thin toolbar (theme toggle + any extra controls) over a
// token-scoped surface that fills the gallery's scroll container. `text-
// foreground` on the wrapper re-declares `color` across the token boundary so
// un-classed descendants don't inherit the shell's color.
export function StageFrame({
  controls,
  children,
}: {
  controls?: (theme: Theme) => ReactNode;
  children: (theme: Theme) => ReactNode;
}) {
  const [theme, setTheme] = useState<Theme>("dark");
  const vars = theme === "dark" ? DARK : LIGHT;
  return (
    <div
      className="flex h-full flex-col bg-background text-foreground"
      style={vars as CSSProperties}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-4 py-2.5">
        <ThemeToggle theme={theme} onChange={setTheme} />
        {controls?.(theme)}
      </div>
      <div className="min-h-0 flex-1">{children(theme)}</div>
    </div>
  );
}

function ThemeToggle({
  theme,
  onChange,
}: {
  theme: Theme;
  onChange: (t: Theme) => void;
}) {
  return (
    <div className="inline-flex items-center rounded-md border border-border bg-card p-0.5">
      {(["dark", "light"] as const).map((t) => {
        const Icon = t === "dark" ? MoonIcon : SunIcon;
        const active = theme === t;
        return (
          <button
            key={t}
            type="button"
            onClick={() => onChange(t)}
            className={cn(
              "flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium capitalize transition-colors",
              active
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-3.5" />
            {t}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------- state vocab */

// State rail color vocabulary (copied from components/looms/utils so the demo
// never imports engine code): sky=running, violet=verifying, emerald=ready,
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

const ACTIVE_STATES: WorkUnitState[] = [
  "scoping",
  "preparing",
  "running",
  "verifying",
];

export const isLoomActive = (s: WorkUnitState) => ACTIVE_STATES.includes(s);
export const isLoomNeedsYou = (s: WorkUnitState) =>
  s === "needs-review" || s === "charter-review" || s === "blocked";

/* ---------------------------------------------------------------- controls */

// Search-first field — the header element that anchors the toolbar, matching
// the lists lane's SearchField (icon left, `/` hint right).
export function SearchField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div className="relative min-w-0 flex-1">
      <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-9 w-full rounded-lg border border-border bg-background/60 pr-10 pl-9 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:bg-background focus:ring-2 focus:ring-ring/30"
      />
      <kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
        /
      </kbd>
    </div>
  );
}

// A pill filter — active uses the primary token, inactive a quiet outline.
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

// Collapsible group header — the sticky band that folds a bucket to a header.
export function GroupHeader({
  icon: Icon,
  label,
  count,
  open,
  onToggle,
  tint,
}: {
  icon?: LucideIcon;
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  tint?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="sticky top-0 z-10 flex w-full items-center gap-2 border-b border-border bg-background/95 px-3 py-1.5 text-left backdrop-blur supports-[backdrop-filter]:bg-background/80"
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
  );
}

/* --------------------------------------------------------------- weave chip */

// The indigo weave marker — kept OUT of the state palette so a woven loom in
// needs-review never shows two competing signals (matches the lists lane).
export function WeaveChip({
  role,
  threads,
  threadsDone,
}: {
  role: DemoLoom["role"];
  threads: number | null;
  threadsDone: number;
}) {
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
  return (
    <Badge
      variant="outline"
      className="shrink-0 gap-1 border-indigo-500/30 bg-indigo-500/10 px-1.5 py-0 font-mono text-[10px] text-indigo-300"
    >
      <WorkflowIcon className="size-2.5" />
      {threads == null
        ? "weave"
        : threadsDone < threads
          ? `${threadsDone}/${threads}`
          : `${threads} thread${threads === 1 ? "" : "s"}`}
    </Badge>
  );
}

/* --------------------------------------------------------------- data rows */

// One dense, selectable session row: title + preview, quiet model/turns
// metadata, a state-toned loom pill if the session wove one, cost + age on the
// right. Selected rows carry a left rail + tinted bg (the list-selection idiom).
export function SessionRow({
  session,
  selected,
  onSelect,
}: {
  session: DemoSession;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "group relative flex w-full items-center gap-3 py-2.5 pr-3 pl-4 text-left transition-colors",
        selected ? "bg-primary/10" : "hover:bg-muted/40",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute top-1.5 bottom-1.5 left-0 w-[3px] rounded-full transition-opacity",
          selected ? "bg-primary opacity-100" : "opacity-0",
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {session.title}
          </span>
          {session.loom && (
            <StateBadge state={session.loom.state} className="shrink-0" />
          )}
        </div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground/80">
          {session.preview}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="font-mono">{session.model}</span>
          <span className="text-border">·</span>
          <span>
            {session.turns} {session.turns === 1 ? "turn" : "turns"}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        <span className="font-mono text-xs tabular-nums">
          {fmtCost(session.costUsd)}
        </span>
        <span className="text-xs text-muted-foreground">
          {fmtAgo(session.updatedAt)}
        </span>
      </div>
    </button>
  );
}

// A state-toned loom card — the data-light pattern: a left state rail, the
// StateBadge, title + weave chip, then quiet kind/attempts and cost/age. Tinted
// border-left picks up the state so a wall of cards is scannable by color.
export function LoomCard({ loom }: { loom: DemoLoom }) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-xl border border-border bg-card p-3 transition-colors hover:border-foreground/25",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute top-0 bottom-0 left-0 w-[3px]",
          railClass(loom.state),
        )}
      />
      <div className="flex items-start gap-2 pl-1.5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-sm font-medium">
              {loom.title}
            </span>
            <WeaveChip
              role={loom.role}
              threads={loom.threads}
              threadsDone={loom.threadsDone}
            />
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <StateBadge state={loom.state} className="shrink-0" />
            <span className="font-mono">{loom.kind}</span>
            {loom.attempts > 1 && (
              <>
                <span className="text-border">·</span>
                <span>{loom.attempts} attempts</span>
              </>
            )}
          </div>
          {loom.error && (
            <p
              className={cn(
                "mt-1.5 truncate text-xs",
                loom.state === "failed"
                  ? "text-destructive/80"
                  : "text-amber-300/80",
              )}
              title={loom.error}
            >
              {loom.error}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-0.5">
          <span className="font-mono text-xs tabular-nums">
            {fmtCost(loom.cost)}
          </span>
          <span className="text-xs text-muted-foreground">
            {fmtAgo(loom.updatedAt)}
          </span>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- helpers */

const DAY = 24 * 60 * 60 * 1000;

export type AgeBucket = "today" | "week" | "older";

export function ageBucket(ts: number): AgeBucket {
  const age = Date.now() - ts;
  if (age < DAY) return "today";
  if (age < 7 * DAY) return "week";
  return "older";
}

export function matchSession(s: DemoSession, needle: string): boolean {
  if (!needle) return true;
  const n = needle.toLowerCase();
  return (
    s.title.toLowerCase().includes(n) ||
    s.preview.toLowerCase().includes(n) ||
    s.model.toLowerCase().includes(n) ||
    s.lastUser.toLowerCase().includes(n) ||
    s.lastAssistant.toLowerCase().includes(n)
  );
}

export function matchLoom(l: DemoLoom, needle: string): boolean {
  if (!needle) return true;
  const n = needle.toLowerCase();
  return (
    l.title.toLowerCase().includes(n) ||
    l.kind.toLowerCase().includes(n) ||
    l.state.toLowerCase().includes(n)
  );
}
