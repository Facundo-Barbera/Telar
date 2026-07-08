"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ActivityIcon,
  CircleDashedIcon,
  ClockIcon,
  FolderGit2Icon,
  GaugeIcon,
  HistoryIcon,
  type LucideIcon,
  PlusIcon,
  RotateCwIcon,
  ShieldIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { ProjectManifest, RegistryEntry, Run } from "@telar/core";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { StateBadge } from "@/components/common/state-badge";
import { fmtDuration, isTerminal, sumCost } from "@/components/runs/utils";
import { fmtAgo, fmtCost } from "@/lib/format";

// Plan-usage shapes mirror lib/store's PlanSnapshot. Declared locally so the
// dashboard (a client component) never pulls the fs-backed store into the bundle.
type PlanWindow = { utilization: number | null; resets_at: string | null };
type PlanSnapshot = {
  capturedAt: number;
  subscriptionType: string | null;
  fiveHour?: PlanWindow | null;
  sevenDay?: PlanWindow | null;
  sevenDayOpus?: PlanWindow | null;
  sevenDaySonnet?: PlanWindow | null;
  modelScoped?: {
    display_name: string;
    utilization: number | null;
    resets_at: string | null;
  }[];
};

type ProjectEntry = {
  entry: RegistryEntry;
  manifest: ProjectManifest | null;
  error: string | null;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function SectionHeading({
  icon: Icon,
  children,
  count,
  action,
}: {
  icon: LucideIcon;
  children: ReactNode;
  count?: number;
  action?: ReactNode;
}) {
  return (
    <div className="mb-2 flex items-center gap-2 px-1">
      <Icon className="size-4 text-muted-foreground" />
      <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {children}
      </h2>
      {count != null && (
        <Badge variant="outline" className="px-1.5 py-0 font-mono text-[10px]">
          {count}
        </Badge>
      )}
      {action && <div className="ml-auto">{action}</div>}
    </div>
  );
}

function ViewAll({ href }: { href: string }) {
  return (
    <Link
      href={href}
      className="text-xs text-muted-foreground transition-colors hover:text-foreground"
    >
      View all
    </Link>
  );
}

// A live tile for one non-terminal run — state, ticking elapsed, project.
function ActiveRunCard({ run, nowTs }: { run: Run; nowTs: number }) {
  return (
    <Link href={`/runs/${run.id}`} className="block">
      <Card size="sm" className="gap-2 transition-shadow hover:ring-foreground/20">
        <CardContent className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <StateBadge state={run.state} />
            <span className="ml-auto flex items-center gap-1 font-mono text-xs text-muted-foreground tabular-nums">
              <ClockIcon className="size-3.5" />
              {fmtDuration(nowTs - run.createdAt)}
            </span>
          </div>
          <span className="truncate text-sm font-medium">{run.title}</span>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <FolderGit2Icon className="size-3.5 shrink-0" />
            <span className="truncate">{run.project}</span>
            <span className="text-border">·</span>
            <span className="font-mono">{run.kind}</span>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

// A needs-review / failed run with its error snippet.
function AttentionRow({ run }: { run: Run }) {
  return (
    <Link
      href={`/runs/${run.id}`}
      className="flex items-start gap-3 px-3 py-3 transition-colors hover:bg-muted/40"
    >
      <StateBadge state={run.state} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{run.title}</span>
          <span className="shrink-0 truncate text-xs text-muted-foreground">
            {run.project}
          </span>
        </div>
        {run.error && (
          <p
            className={cn(
              "mt-1 line-clamp-2 font-mono text-xs",
              run.state === "failed" ? "text-destructive" : "text-amber-300",
            )}
          >
            {run.error}
          </p>
        )}
      </div>
      <span className="shrink-0 text-xs text-muted-foreground">
        {fmtAgo(run.updatedAt)}
      </span>
    </Link>
  );
}

// A compact terminal-run row for the recent-outcomes list.
function RecentRow({ run }: { run: Run }) {
  return (
    <Link
      href={`/runs/${run.id}`}
      className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-muted/40"
    >
      <StateBadge state={run.state} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">
        {run.title}
      </span>
      <span className="hidden shrink-0 truncate text-xs text-muted-foreground sm:inline">
        {run.project}
      </span>
      <span className="shrink-0 font-mono text-xs text-muted-foreground">
        {fmtCost(sumCost(run.attempts))}
      </span>
      <span className="w-14 shrink-0 text-right text-xs text-muted-foreground">
        {fmtAgo(run.updatedAt)}
      </span>
    </Link>
  );
}

function ProjectMiniCard({ entry, manifest, error }: ProjectEntry) {
  const href = `/projects/${encodeURIComponent(entry.name)}`;
  if (!manifest || error) {
    return (
      <Link href={href} className="block">
        <Card
          size="sm"
          className="h-full bg-destructive/5 ring-destructive/25 transition-shadow hover:ring-destructive/40"
        >
          <CardContent className="flex flex-col gap-2">
            <div className="flex items-center gap-1.5">
              <TriangleAlertIcon className="size-4 shrink-0 text-destructive" />
              <span className="truncate text-sm font-medium">{entry.name}</span>
            </div>
            <Badge variant="destructive" className="w-fit text-[10px]">
              manifest error
            </Badge>
          </CardContent>
        </Card>
      </Link>
    );
  }
  const gates = manifest.gates.length;
  return (
    <Link href={href} className="block">
      <Card size="sm" className="h-full transition-shadow hover:ring-foreground/20">
        <CardContent className="flex flex-col gap-2">
          <span className="truncate text-sm font-medium">{manifest.name}</span>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="text-[10px]">
              {manifest.account}
            </Badge>
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <ShieldIcon className="size-3.5" />
              {gates === 0 ? "no gates" : plural(gates, "gate")}
            </span>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

function RegisterCard() {
  return (
    <Link
      href="/projects"
      className="flex min-h-[76px] flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-border text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
    >
      <PlusIcon className="size-4" />
      <span className="text-xs font-medium">Register a project</span>
    </Link>
  );
}

function UsageMeter({ label, window }: { label: string; window: PlanWindow }) {
  const pct = window.utilization ?? 0;
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono text-muted-foreground tabular-nums">
          {window.utilization != null ? `${Math.round(pct)}%` : "—"}
        </span>
      </div>
      <Progress
        value={Math.min(100, pct)}
        className={cn(
          "h-1",
          pct >= 90 && "[&>[data-slot=progress-indicator]]:bg-destructive",
        )}
      />
    </div>
  );
}

function AccountUsage({ account, snap }: { account: string; snap: PlanSnapshot }) {
  return (
    <Card size="sm" className="min-w-0">
      <CardContent className="flex flex-col gap-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium">
            Plan · <span className="font-mono">{account}</span>
          </span>
          {snap.subscriptionType && (
            <Badge variant="secondary" className="font-mono text-[10px] uppercase">
              {snap.subscriptionType}
            </Badge>
          )}
        </div>
        {snap.fiveHour && <UsageMeter label="Session · 5h" window={snap.fiveHour} />}
        {snap.sevenDay && <UsageMeter label="Weekly" window={snap.sevenDay} />}
        {snap.sevenDayOpus && (
          <UsageMeter label="Weekly · Opus" window={snap.sevenDayOpus} />
        )}
      </CardContent>
    </Card>
  );
}

export default function DashboardPage() {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectEntry[] | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [plan, setPlan] = useState<Record<string, PlanSnapshot>>({});
  const [nowTs, setNowTs] = useState(() => Date.now());

  const load = useCallback(() => {
    fetch("/api/runs")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => {
        setRuns(Array.isArray(d.runs) ? d.runs : []);
        setRunsError(null);
      })
      .catch((e) => setRunsError(e instanceof Error ? e.message : String(e)));

    fetch("/api/projects")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => {
        setProjects(Array.isArray(d.projects) ? d.projects : []);
        setProjectsError(null);
      })
      .catch((e) => setProjectsError(e instanceof Error ? e.message : String(e)));

    fetch("/api/usage")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setPlan(d.plan ?? {}))
      .catch(() => {});
  }, []);

  // Refetch on mount + whenever a sibling surface broadcasts telar:refresh.
  useEffect(() => {
    load();
    window.addEventListener("telar:refresh", load);
    return () => window.removeEventListener("telar:refresh", load);
  }, [load]);

  const activeRuns = useMemo(
    () => (runs ? runs.filter((r) => !isTerminal(r.state)) : []),
    [runs],
  );
  const hasActive = activeRuns.length > 0;

  // While work is in flight, poll (5s) and tick the elapsed clocks (1s).
  useEffect(() => {
    if (!hasActive) return;
    const poll = setInterval(load, 5000);
    const tick = setInterval(() => setNowTs(Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [hasActive, load]);

  const attention = runs
    ? runs
        .filter((r) => r.state === "needs-review" || r.state === "failed")
        .slice(0, 5)
    : [];
  const recent = runs ? runs.filter((r) => isTerminal(r.state)).slice(0, 8) : [];
  const planEntries = Object.entries(plan).sort(([a], [b]) =>
    a === "personal" ? -1 : b === "personal" ? 1 : a.localeCompare(b),
  );

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <PageHeader
        title="telar"
        description="What's weaving now, what needs attention, and every project on the loom."
        actions={
          <Button render={<Link href="/runs?new=1" />}>
            <PlusIcon />
            New run
          </Button>
        }
      />

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-6xl space-y-8 px-6 py-6">
          {/* Runs area: active, needs-attention, recent — one loading/error gate. */}
          {runs === null ? (
            runsError ? (
              <EmptyState
                icon={TriangleAlertIcon}
                iconClassName="text-destructive/60"
                title="Couldn't load runs"
                description={
                  <span className="font-mono text-xs break-words">
                    {runsError}
                  </span>
                }
                action={
                  <Button variant="outline" size="sm" onClick={load}>
                    <RotateCwIcon />
                    Retry
                  </Button>
                }
              />
            ) : (
              <section>
                <SectionHeading icon={ActivityIcon}>Active now</SectionHeading>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Skeleton className="h-24 rounded-xl" />
                  <Skeleton className="h-24 rounded-xl" />
                </div>
              </section>
            )
          ) : (
            <>
              <section>
                <SectionHeading
                  icon={ActivityIcon}
                  count={activeRuns.length || undefined}
                >
                  Active now
                </SectionHeading>
                {activeRuns.length === 0 ? (
                  <EmptyState
                    className="py-10"
                    icon={CircleDashedIcon}
                    title="The loom is idle"
                    description="No runs in flight. Start one and watch it weave."
                    action={
                      <Button
                        variant="outline"
                        size="sm"
                        render={<Link href="/runs?new=1" />}
                      >
                        <PlusIcon />
                        New run
                      </Button>
                    }
                  />
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {activeRuns.map((run) => (
                      <ActiveRunCard key={run.id} run={run} nowTs={nowTs} />
                    ))}
                  </div>
                )}
              </section>

              {attention.length > 0 && (
                <section>
                  <SectionHeading icon={TriangleAlertIcon} count={attention.length}>
                    Needs attention
                  </SectionHeading>
                  <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
                    {attention.map((run) => (
                      <AttentionRow key={run.id} run={run} />
                    ))}
                  </div>
                </section>
              )}

              {recent.length > 0 && (
                <section>
                  <SectionHeading
                    icon={HistoryIcon}
                    action={<ViewAll href="/runs" />}
                  >
                    Recent runs
                  </SectionHeading>
                  <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
                    {recent.map((run) => (
                      <RecentRow key={run.id} run={run} />
                    ))}
                  </div>
                </section>
              )}
            </>
          )}

          {/* Projects */}
          <section>
            <SectionHeading
              icon={FolderGit2Icon}
              count={projects?.length || undefined}
              action={<ViewAll href="/projects" />}
            >
              Projects
            </SectionHeading>
            {projects === null ? (
              projectsError ? (
                <EmptyState
                  className="py-10"
                  icon={TriangleAlertIcon}
                  iconClassName="text-destructive/60"
                  title="Couldn't load projects"
                  description={
                    <span className="font-mono text-xs break-words">
                      {projectsError}
                    </span>
                  }
                  action={
                    <Button variant="outline" size="sm" onClick={load}>
                      <RotateCwIcon />
                      Retry
                    </Button>
                  }
                />
              ) : (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <Skeleton key={i} className="h-20 rounded-xl" />
                  ))}
                </div>
              )
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {projects.map((p) => (
                  <ProjectMiniCard key={p.entry.name} {...p} />
                ))}
                <RegisterCard />
              </div>
            )}
          </section>

          {/* Usage */}
          <section>
            <SectionHeading icon={GaugeIcon}>Plan usage</SectionHeading>
            {planEntries.length === 0 ? (
              <p className="px-1 text-sm text-muted-foreground">
                Plan usage appears after your first turn.
              </p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {planEntries.map(([account, snap]) => (
                  <AccountUsage key={account} account={account} snap={snap} />
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
