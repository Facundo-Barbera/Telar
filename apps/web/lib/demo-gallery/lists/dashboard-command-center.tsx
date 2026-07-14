"use client";

// LANE: lists — Dashboard, Variant A: Command Center (concern 2 + 5).
// CURRENT: a single long vertical scroll — Active now, Needs attention, Recent
// looms, Recent sessions, Projects, Plan usage stacked full-width; at scale you
// scroll a screen and a half to see everything and nothing is prioritized.
// REDESIGN: a running-now command center. A KPI hero answers "what needs me?"
// above the fold, then a two-column deck puts live work + what's waiting on the
// left and today's sessions / hot projects / plan usage on the right — one
// screen, no scroll to triage.
import { useMemo, useState } from "react";
import {
  ActivityIcon,
  ClockIcon,
  FolderGit2Icon,
  GaugeIcon,
  LayersIcon,
  MessagesSquareIcon,
  SparklesIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { StateBadge } from "@/components/common/state-badge";
import { fmtAgo, fmtCost } from "../now";
import {
  DEMO_PROJECTS,
  DEMO_SESSIONS,
  needsYouLooms,
  runningLooms,
  totalSpendToday,
  wovenThreadsInFlight,
  type DemoLoom,
} from "./fixtures";
import {
  SearchField,
  StatTile,
  ThreadProgress,
  WeaveChip,
  railClass,
} from "./shared";

function RunningRow({ loom }: { loom: DemoLoom }) {
  const woven = loom.role === "woven" && loom.threads != null;
  return (
    <div className="relative flex items-center gap-3 py-2 pr-2 pl-3.5">
      <span
        aria-hidden
        className={cn(
          "absolute top-1.5 bottom-1.5 left-0 w-[3px] rounded-full",
          railClass(loom.state),
        )}
      />
      <StateBadge state={loom.state} className="shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{loom.title}</span>
          <WeaveChip role={loom.role} threads={loom.threads} threadsDone={loom.threadsDone} />
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          <FolderGit2Icon className="size-3 shrink-0" />
          <span className="truncate">{loom.project}</span>
          {woven && (
            <>
              <span className="text-border">·</span>
              <ThreadProgress threads={loom.threads ?? 0} threadsDone={loom.threadsDone} />
            </>
          )}
        </div>
      </div>
      <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
        {fmtCost(loom.cost)}
      </span>
    </div>
  );
}

function AttentionRow({ loom }: { loom: DemoLoom }) {
  return (
    <div className="relative flex items-start gap-3 py-2 pr-2 pl-3.5">
      <span
        aria-hidden
        className={cn(
          "absolute top-1.5 bottom-1.5 left-0 w-[3px] rounded-full",
          railClass(loom.state),
        )}
      />
      <StateBadge state={loom.state} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{loom.title}</span>
        {loom.error ? (
          <p
            className={cn(
              "mt-0.5 line-clamp-1 text-xs",
              loom.state === "failed" ? "text-destructive/80" : "text-amber-300/80",
            )}
          >
            {loom.error}
          </p>
        ) : (
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {loom.project}
          </span>
        )}
      </div>
      <span className="shrink-0 text-[11px] text-muted-foreground">
        {fmtAgo(loom.updatedAt)}
      </span>
    </div>
  );
}

function Panel({
  icon: Icon,
  title,
  count,
  tint,
  children,
  action,
}: {
  icon: typeof ActivityIcon;
  title: string;
  count?: number;
  tint?: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Icon className={cn("size-4", tint ?? "text-muted-foreground")} />
        <h2 className="text-xs font-semibold tracking-wide text-foreground uppercase">
          {title}
        </h2>
        {count != null && (
          <span className="rounded bg-muted px-1.5 font-mono text-[10px] text-muted-foreground">
            {count}
          </span>
        )}
        {action && <div className="ml-auto">{action}</div>}
      </div>
      {children}
    </section>
  );
}

function UsageMeter({ label, pct }: { label: string; pct: number }) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono text-muted-foreground tabular-nums">{pct}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full",
            pct >= 90 ? "bg-destructive" : pct >= 70 ? "bg-amber-400" : "bg-primary",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function DashboardCommandCenterDemo() {
  const [q, setQ] = useState("");
  const liveSessions = useMemo(
    () => [...DEMO_SESSIONS].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6),
    [],
  );
  const hotProjects = useMemo(
    () =>
      [...DEMO_PROJECTS]
        .sort((a, b) => b.running + b.openLooms - (a.running + a.openLooms))
        .filter((p) => p.running > 0 || p.openLooms > 0)
        .slice(0, 5),
    [],
  );

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5">
        <div className="shrink-0">
          <h1 className="font-heading text-base font-semibold tracking-tight">telar</h1>
          <p className="text-xs text-muted-foreground">Command center</p>
        </div>
        <SearchField
          value={q}
          onChange={setQ}
          placeholder="Jump to a loom, session, or project…"
        />
        <Button size="sm">
          <SparklesIcon />
          New loom session
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-6xl space-y-4 px-4 py-4">
          {/* KPI hero — above-the-fold triage */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <StatTile
              icon={ActivityIcon}
              label="Running now"
              value={runningLooms.length}
              sub="looms in flight"
              tint="text-sky-400"
            />
            <StatTile
              icon={TriangleAlertIcon}
              label="Needs you"
              value={needsYouLooms.length}
              sub="waiting on a decision"
              tint="text-amber-400"
            />
            <StatTile
              icon={LayersIcon}
              label="Threads weaving"
              value={wovenThreadsInFlight}
              sub="across woven looms"
              tint="text-indigo-300"
            />
            <StatTile
              icon={GaugeIcon}
              label="Spend today"
              value={fmtCost(totalSpendToday)}
              sub="main + sub-agents"
              tint="text-muted-foreground"
            />
            <div className="col-span-2 flex flex-col justify-center gap-2 rounded-xl border border-border bg-card px-3.5 py-3 sm:col-span-1">
              <UsageMeter label="Session · 5h" pct={62} />
              <UsageMeter label="Weekly · Opus" pct={81} />
            </div>
          </div>

          {/* Two-column command deck */}
          <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
            <div className="space-y-4">
              <Panel
                icon={ActivityIcon}
                title="Running now"
                count={runningLooms.length}
                tint="text-sky-400"
              >
                <div className="divide-y divide-border">
                  {runningLooms.map((l) => (
                    <RunningRow key={l.id} loom={l} />
                  ))}
                </div>
              </Panel>

              <Panel
                icon={TriangleAlertIcon}
                title="Needs you"
                count={needsYouLooms.length}
                tint="text-amber-400"
              >
                <div className="divide-y divide-border">
                  {needsYouLooms.map((l) => (
                    <AttentionRow key={l.id} loom={l} />
                  ))}
                </div>
              </Panel>
            </div>

            <div className="space-y-4">
              <Panel
                icon={MessagesSquareIcon}
                title="Today's sessions"
                count={liveSessions.length}
              >
                <div className="divide-y divide-border">
                  {liveSessions.map((s) => (
                    <div key={s.id} className="flex items-center gap-2.5 px-3 py-2">
                      {s.live ? (
                        <span className="relative flex size-2 shrink-0">
                          <span className="absolute inline-flex size-full animate-ping rounded-full bg-sky-400 opacity-60" />
                          <span className="relative inline-flex size-2 rounded-full bg-sky-400" />
                        </span>
                      ) : (
                        <span className="size-2 shrink-0 rounded-full bg-muted-foreground/30" />
                      )}
                      <div className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{s.title}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {s.project}
                        </span>
                      </div>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {fmtAgo(s.updatedAt)}
                      </span>
                    </div>
                  ))}
                </div>
              </Panel>

              <Panel icon={FolderGit2Icon} title="Hot projects">
                <div className="divide-y divide-border">
                  {hotProjects.map((p) => (
                    <div key={p.name} className="flex items-center gap-2.5 px-3 py-2">
                      <FolderGit2Icon className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-sm">{p.name}</span>
                      {p.running > 0 && (
                        <span className="flex items-center gap-1 font-mono text-[11px] text-sky-400 tabular-nums">
                          <ClockIcon className="size-3" />
                          {p.running}
                        </span>
                      )}
                      <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
                        {p.openLooms} open
                      </span>
                    </div>
                  ))}
                </div>
              </Panel>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
