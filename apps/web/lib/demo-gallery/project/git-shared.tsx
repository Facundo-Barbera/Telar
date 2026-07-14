"use client";

// LANE: project (NEW) — shared shell + primitives for the project Git tab demos
// (project-git-* entries). The Git tab lives INSIDE the hub-c anatomy, so this
// reproduces that anatomy exactly: the compact project header + the tab strip
// Sessions | Looms | Git | Settings, with Git active. Non-git tabs are stubs
// that point back at project-hub-c (this lane owns the Git tab only). Theming
// rides on the shared StageFrame token wrapper — no `dark:` utilities, both
// themes render in-page.
import { useState, type ReactNode } from "react";
import {
  FolderGit2Icon,
  GitBranchIcon,
  MessagesSquareIcon,
  PlusIcon,
  SlidersHorizontalIcon,
  WorkflowIcon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DEMO_PROJECT } from "./fixtures";
import { StageFrame, type Theme } from "./shared";

type HubTab = "sessions" | "looms" | "git" | "settings";

const HUB_TABS: { key: HubTab; label: string; icon: LucideIcon }[] = [
  { key: "sessions", label: "Sessions", icon: MessagesSquareIcon },
  { key: "looms", label: "Looms", icon: WorkflowIcon },
  { key: "git", label: "Git", icon: GitBranchIcon },
  { key: "settings", label: "Settings", icon: SlidersHorizontalIcon },
];

// The hub anatomy around a Git-tab body. Git is the standing active tab; the
// other three are live but render a stub (they're project-hub-c's job).
export function HubShell({
  controls,
  children,
}: {
  controls?: (theme: Theme) => ReactNode;
  children: (theme: Theme) => ReactNode;
}) {
  return (
    <StageFrame controls={controls}>
      {(theme) => <HubBody theme={theme}>{children(theme)}</HubBody>}
    </StageFrame>
  );
}

function HubBody({ theme, children }: { theme: Theme; children: ReactNode }) {
  const [tab, setTab] = useState<HubTab>("git");
  return (
    <div className="flex h-full flex-col">
      {/* COMPACT header — identity + primary action (hub-c verbatim register). */}
      <div className="shrink-0 border-b border-border bg-background/60 px-4 pt-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-card">
            <FolderGit2Icon className="size-4.5 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate font-heading text-sm font-semibold tracking-tight">
                {DEMO_PROJECT.name}
              </h1>
              <Badge
                variant="outline"
                className="shrink-0 border-sky-500/25 bg-sky-500/5 px-1.5 py-0 text-[10px] text-sky-300"
              >
                {DEMO_PROJECT.account}
              </Badge>
              <Badge
                variant="outline"
                className="shrink-0 px-1.5 py-0 font-mono text-[10px] text-muted-foreground"
              >
                {DEMO_PROJECT.branch}
              </Badge>
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {DEMO_PROJECT.root}
            </p>
          </div>
          <Button size="sm">
            <PlusIcon />
            New session
          </Button>
        </div>

        <div className="mt-3 flex items-center gap-1">
          {HUB_TABS.map((tItem) => {
            const on = tab === tItem.key;
            return (
              <button
                key={tItem.key}
                type="button"
                onClick={() => setTab(tItem.key)}
                className={cn(
                  "flex items-center gap-1.5 rounded-t-lg border-b-2 px-3 py-2 text-xs font-medium transition-colors",
                  on
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                <tItem.icon className="size-3.5" />
                {tItem.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* BODY */}
      <div className="min-h-0 flex-1">
        {tab === "git" ? children : <TabStub tab={tab} />}
      </div>
    </div>
  );
}

function TabStub({ tab }: { tab: Exclude<HubTab, "git"> }) {
  const label = HUB_TABS.find((t) => t.key === tab)!.label;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
      <p className="text-sm text-muted-foreground">
        The <span className="font-medium text-foreground">{label}</span> tab is
        specified in{" "}
        <span className="font-mono text-xs text-foreground">project-hub-c</span>.
      </p>
      <p className="max-w-sm text-xs text-muted-foreground/70">
        This demo focuses the Git tab. Switch back to Git to see it.
      </p>
    </div>
  );
}

/* --------------------------------------------------------- git primitives */

// ~ size formatter — the tilde is load-bearing (these are du estimates).
export function fmtSize(mb: number): string {
  if (mb >= 1024) return `~${(mb / 1024).toFixed(1)} GB`;
  return `~${Math.round(mb)} MB`;
}

// A tiny state chip in the git tab's own quiet vocabulary. Reclaimable is the
// one that earns color (emerald) — it's the affordance the whole tab exists for.
export function GitChip({
  tone,
  children,
  className,
}: {
  tone: "reclaimable" | "active" | "dirty" | "merged" | "stale" | "muted";
  children: ReactNode;
  className?: string;
}) {
  const tones: Record<string, string> = {
    reclaimable: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
    active: "border-sky-500/30 bg-sky-500/10 text-sky-300",
    dirty: "border-amber-500/40 bg-amber-500/10 text-amber-300",
    merged: "border-border bg-muted/40 text-muted-foreground",
    stale: "border-border bg-transparent text-muted-foreground/80",
    muted: "border-border bg-transparent text-muted-foreground",
  };
  return (
    <Badge
      variant="outline"
      className={cn(
        "shrink-0 gap-1 px-1.5 py-0 font-mono text-[10px]",
        tones[tone],
        className,
      )}
    >
      {children}
    </Badge>
  );
}

// The section band used to head Worktrees / Branches / Activity / Issues / PRs.
export function SectionBand({
  icon: Icon,
  label,
  count,
  right,
}: {
  icon: LucideIcon;
  label: string;
  count?: number;
  right?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 px-4 py-2">
      <Icon className="size-4 text-muted-foreground" />
      <span className="text-xs font-semibold tracking-wide text-foreground uppercase">
        {label}
      </span>
      {count != null && (
        <Badge
          variant="outline"
          className="px-1.5 py-0 font-mono text-[10px] text-muted-foreground"
        >
          {count}
        </Badge>
      )}
      {right && <div className="ml-auto flex items-center gap-2">{right}</div>}
    </div>
  );
}
