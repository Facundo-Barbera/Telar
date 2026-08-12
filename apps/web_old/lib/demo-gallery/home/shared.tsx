// LANE: home (UX brainstorm 2026-07-23) — shared visual vocabulary for the
// FINAL home (the loom-aware graft on the active dashboard). Follows the
// production tone law (status.tsx): hue on the icon only, badges stay
// neutral outlines, the 3px rail is the only colored surface, active work
// gets a neutral spinner and never a hue.
import {
  ActivityIcon,
  CircleAlertIcon,
  FlaskConicalIcon,
  FolderGit2Icon,
  HammerIcon,
  LayoutDashboardIcon,
  Loader2Icon,
  NetworkIcon,
  PauseIcon,
  RotateCcwIcon,
  SettingsIcon,
  InboxIcon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { FleetPhase } from "./fixtures";

export const PHASE: Record<
  FleetPhase,
  { Icon: LucideIcon; label: string; icon: string; rail: string; spin?: boolean }
> = {
  prepare: {
    Icon: NetworkIcon,
    label: "preparing",
    icon: "text-muted-foreground",
    rail: "bg-border",
  },
  build: {
    Icon: HammerIcon,
    label: "building",
    icon: "text-foreground",
    rail: "bg-foreground/40",
    spin: true,
  },
  verify: {
    Icon: FlaskConicalIcon,
    label: "verifying",
    icon: "text-foreground",
    rail: "bg-foreground/40",
    spin: true,
  },
  repair: {
    Icon: RotateCcwIcon,
    label: "repairing",
    icon: "text-destructive",
    rail: "bg-destructive",
    spin: true,
  },
  ready: {
    Icon: FlaskConicalIcon,
    label: "ready for you",
    icon: "text-emerald-600 dark:text-emerald-400",
    rail: "bg-emerald-600 dark:bg-emerald-400",
  },
  blocked: {
    Icon: CircleAlertIcon,
    label: "question parked",
    icon: "text-amber-600 dark:text-amber-400",
    rail: "bg-amber-600 dark:bg-amber-400",
  },
  parked: {
    Icon: PauseIcon,
    label: "parked",
    icon: "text-muted-foreground",
    rail: "bg-border",
  },
};

// Tinted-outline phase chip: neutral border, hue on the icon only. Active
// phases show the neutral spinner next to the (static) phase icon color.
export function PhaseChip({
  phase,
  className,
}: {
  phase: FleetPhase;
  className?: string;
}) {
  const p = PHASE[phase];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground",
        className,
      )}
    >
      {p.spin ? (
        <Loader2Icon className="size-3 animate-spin text-foreground" />
      ) : (
        <p.Icon className={cn("size-3", p.icon)} />
      )}
      {p.label}
    </span>
  );
}

export function ProjectTag({ name }: { name: string }) {
  return (
    <span className="inline-flex shrink-0 items-center rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
      {name}
    </span>
  );
}

// The streaming-evidence placeholder: a fake screenshot (wireframe bars) with
// the artifact name + age underneath. Also consumed by the loom-detail lane's
// thread drill — keep the export stable.
export function EvidenceThumb({
  evidence,
  wide,
}: {
  evidence: { label: string; age: string };
  wide?: boolean;
}) {
  return (
    <figure className={cn("shrink-0", wide ? "w-36" : "w-24")}>
      <div className="flex aspect-video flex-col gap-1 rounded-md border border-border bg-muted/30 p-1.5">
        <div className="h-1.5 w-2/3 rounded-sm bg-muted-foreground/20" />
        <div className="h-1.5 w-1/2 rounded-sm bg-muted-foreground/15" />
        <div className="mt-auto flex gap-1">
          <div className="h-3 flex-1 rounded-sm bg-muted-foreground/10" />
          <div className="h-3 w-1/3 rounded-sm bg-muted-foreground/20" />
        </div>
      </div>
      <figcaption className="mt-1 truncate font-mono text-[9px] text-muted-foreground/60">
        {evidence.label} · {evidence.age}
      </figcaption>
    </figure>
  );
}

// Static shell: left nav with Dashboard active — the frame the final home
// renders inside.
export function FauxShell({ children }: { children: React.ReactNode }) {
  const nav = [
    { label: "Dashboard", Icon: LayoutDashboardIcon, active: true },
    { label: "Workspace", Icon: InboxIcon },
    { label: "Projects", Icon: FolderGit2Icon },
    { label: "Looms", Icon: ActivityIcon },
  ];
  return (
    <div className="flex h-full bg-background">
      <aside className="hidden w-56 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex">
        <div className="flex h-14 items-center border-b border-sidebar-border px-4">
          <span className="font-heading text-lg font-semibold tracking-tight">
            telar
          </span>
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
          {nav.map(({ label, Icon, active }) => (
            <div
              key={label}
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                active
                  ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/70",
              )}
            >
              <Icon className="size-4 shrink-0" />
              <span className="flex-1">{label}</span>
            </div>
          ))}
        </nav>
        <div className="border-t border-sidebar-border p-2">
          <div className="flex items-center gap-2 rounded-md p-2 text-sm text-sidebar-foreground/60">
            <SettingsIcon className="size-4" /> Settings
          </div>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
