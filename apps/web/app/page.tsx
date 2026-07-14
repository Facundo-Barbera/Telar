"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ActivityIcon,
  ClockIcon,
  FolderGit2Icon,
  GaugeIcon,
  LayersIcon,
  MessagesSquareIcon,
  PlusIcon,
  RotateCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { Loom, ProjectManifest, RegistryEntry } from "@telar/core";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { StateBadge } from "@/components/common/state-badge";
import {
  SearchField,
  StatTile,
  WeaveChip,
  isLoomNeedsYou,
  isLoomRunning,
} from "@/components/common/list-controls";
import { loomRole, stateRailClass, sumCost, threadCount } from "@/components/looms/utils";
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
};

type ProjectEntry = {
  entry: RegistryEntry;
  manifest: ProjectManifest | null;
  error: string | null;
};

// The chat-list shape GET /api/chats returns — a message-less Chat plus a
// last-message preview. `preview` optional so an older API degrades gracefully.
type SessionMeta = {
  id: string;
  title: string;
  project?: string;
  updatedAt: number;
  preview?: string;
};

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

// Running loom row — rail + state + title/weave, project, and running cost.
function RunningRow({ loom }: { loom: Loom }) {
  return (
    <Link
      href={`/looms/${loom.id}`}
      className="relative flex items-center gap-3 py-2 pr-2 pl-3.5 transition-colors hover:bg-muted/40"
    >
      <span
        aria-hidden
        className={cn(
          "absolute top-1.5 bottom-1.5 left-0 w-[3px] rounded-full",
          stateRailClass(loom.state),
        )}
      />
      <StateBadge state={loom.state} className="shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{loom.title}</span>
          <WeaveChip loom={loom} />
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          <FolderGit2Icon className="size-3 shrink-0" />
          <span className="truncate">{loom.project}</span>
        </div>
      </div>
      <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
        {fmtCost(sumCost(loom.attempts))}
      </span>
    </Link>
  );
}

// Needs-you loom row — rail + state, title, and either its blocking error
// (failed/needs-review) or its project, with the age on the right.
function AttentionRow({ loom }: { loom: Loom }) {
  const showError =
    !!loom.error &&
    (loom.state === "failed" || loom.state === "needs-review");
  return (
    <Link
      href={`/looms/${loom.id}`}
      className="relative flex items-start gap-3 py-2 pr-2 pl-3.5 transition-colors hover:bg-muted/40"
    >
      <span
        aria-hidden
        className={cn(
          "absolute top-1.5 bottom-1.5 left-0 w-[3px] rounded-full",
          stateRailClass(loom.state),
        )}
      />
      <StateBadge state={loom.state} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{loom.title}</span>
        {showError ? (
          <p
            className={cn(
              "mt-0.5 line-clamp-1 text-xs",
              loom.state === "failed"
                ? "text-destructive/80"
                : "text-amber-300/80",
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
    </Link>
  );
}

function Panel({
  icon: Icon,
  title,
  count,
  tint,
  children,
}: {
  icon: typeof ActivityIcon;
  title: string;
  count?: number;
  tint?: string;
  children: React.ReactNode;
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
      </div>
      {children}
    </section>
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
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full",
            pct >= 90 ? "bg-destructive" : pct >= 70 ? "bg-amber-400" : "bg-primary",
          )}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
    </div>
  );
}

function EmptyPanelRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 py-6 text-center text-xs text-muted-foreground">
      {children}
    </div>
  );
}

export default function DashboardPage() {
  const [looms, setLooms] = useState<Loom[] | null>(null);
  const [loomsError, setLoomsError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [plan, setPlan] = useState<Record<string, PlanSnapshot>>({});
  const [q, setQ] = useState("");

  const load = useCallback(() => {
    fetch("/api/looms")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => {
        setLooms(Array.isArray(d.looms) ? d.looms : []);
        setLoomsError(null);
      })
      .catch((e) => setLoomsError(e instanceof Error ? e.message : String(e)));

    fetch("/api/projects")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setProjects(Array.isArray(d.projects) ? d.projects : []))
      .catch(() => {});

    fetch("/api/chats")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        const chats: SessionMeta[] = Array.isArray(d.chats) ? d.chats : [];
        setSessions(chats.filter((c) => c.project));
      })
      .catch(() => {});

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

  const runningLooms = useMemo(
    () => (looms ? looms.filter((l) => isLoomRunning(l.state)) : []),
    [looms],
  );
  const hasActive = runningLooms.length > 0;

  // While work is in flight, poll (5s).
  useEffect(() => {
    if (!hasActive) return;
    const poll = setInterval(load, 5000);
    return () => clearInterval(poll);
  }, [hasActive, load]);

  const needsYouLooms = useMemo(
    () => (looms ? looms.filter((l) => isLoomNeedsYou(l.state)) : []),
    [looms],
  );

  // Threads across active woven looms (total, not remaining — per-thread
  // completion isn't carried on the list route; see gaps).
  const threadsWeaving = runningLooms
    .filter((l) => loomRole(l) === "woven")
    .reduce((s, l) => s + (threadCount(l) ?? 0), 0);

  // Spend across looms touched today — sums each loom's attempt cost.
  const spendToday = useMemo(() => {
    if (!looms) return 0;
    const today = startOfToday();
    return looms
      .filter((l) => l.updatedAt >= today)
      .reduce((s, l) => s + sumCost(l.attempts), 0);
  }, [looms]);

  const needle = q.trim().toLowerCase();
  const matchLoom = (l: Loom) =>
    !needle ||
    l.title.toLowerCase().includes(needle) ||
    l.project.toLowerCase().includes(needle);

  const runningShown = runningLooms.filter(matchLoom);
  const needsYouShown = needsYouLooms.filter(matchLoom).slice(0, 6);

  const liveSessions = useMemo(
    () =>
      [...sessions]
        .filter(
          (s) =>
            !needle ||
            s.title.toLowerCase().includes(needle) ||
            (s.project ?? "").toLowerCase().includes(needle),
        )
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 6),
    [sessions, needle],
  );

  // Hot projects — busiest repos by derived running + open looms.
  const hotProjects = useMemo(() => {
    if (!looms) return [];
    const stat = new Map<string, { running: number; open: number }>();
    for (const l of looms) {
      const s = stat.get(l.project) ?? { running: 0, open: 0 };
      if (isLoomRunning(l.state)) {
        s.running += 1;
        s.open += 1;
      } else if (isLoomNeedsYou(l.state)) {
        s.open += 1;
      }
      stat.set(l.project, s);
    }
    return projects
      .map((p) => ({
        name: p.entry.name,
        running: stat.get(p.entry.name)?.running ?? 0,
        open: stat.get(p.entry.name)?.open ?? 0,
      }))
      .filter(
        (p) =>
          (p.running > 0 || p.open > 0) &&
          (!needle || p.name.toLowerCase().includes(needle)),
      )
      .sort((a, b) => b.running + b.open - (a.running + a.open))
      .slice(0, 5);
  }, [looms, projects, needle]);

  // Primary plan snapshot for the hero usage tile — personal first.
  const planEntries = Object.entries(plan).sort(([a], [b]) =>
    a === "personal" ? -1 : b === "personal" ? 1 : a.localeCompare(b),
  );
  const primaryPlan = planEntries[0]?.[1];
  const weeklyWindow = primaryPlan?.sevenDayOpus ?? primaryPlan?.sevenDay;

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <PageHeader
        title="telar"
        description="Command center — what's weaving now, what needs you."
        actions={
          <Button size="sm" render={<Link href="/looms?new=1" />}>
            <PlusIcon />
            New loom session
          </Button>
        }
      />

      {/* Search-first toolbar */}
      <div className="shrink-0 border-b border-border">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-2 px-4 py-2.5">
          <SearchField
            value={q}
            onChange={setQ}
            placeholder="Filter looms, sessions, and projects…"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-6xl space-y-4 px-4 py-4">
          {looms === null && loomsError ? (
            <EmptyState
              icon={TriangleAlertIcon}
              iconClassName="text-destructive/60"
              title="Couldn't load looms"
              description={
                <span className="font-mono text-xs break-words">
                  {loomsError}
                </span>
              }
              action={
                <Button variant="outline" size="sm" onClick={load}>
                  <RotateCwIcon />
                  Retry
                </Button>
              }
            />
          ) : looms === null ? (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-20 rounded-xl" />
                ))}
              </div>
              <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
                <Skeleton className="h-64 rounded-xl" />
                <Skeleton className="h-64 rounded-xl" />
              </div>
            </>
          ) : (
            <>
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
                  value={threadsWeaving}
                  sub="across woven looms"
                  tint="text-indigo-300"
                />
                <StatTile
                  icon={GaugeIcon}
                  label="Spend today"
                  value={fmtCost(spendToday)}
                  sub="across today's looms"
                  tint="text-muted-foreground"
                />
                <div className="col-span-2 flex flex-col justify-center gap-2 rounded-xl border border-border bg-card px-3.5 py-3 text-card-foreground sm:col-span-1">
                  {primaryPlan ? (
                    <>
                      {primaryPlan.fiveHour && (
                        <UsageMeter
                          label="Session · 5h"
                          window={primaryPlan.fiveHour}
                        />
                      )}
                      {weeklyWindow && (
                        <UsageMeter label="Weekly" window={weeklyWindow} />
                      )}
                      {!primaryPlan.fiveHour && !weeklyWindow && (
                        <p className="text-xs text-muted-foreground">
                          Plan usage appears after your first turn.
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Plan usage appears after your first turn.
                    </p>
                  )}
                </div>
              </div>

              {/* Two-column command deck */}
              <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
                <div className="space-y-4">
                  <Panel
                    icon={ActivityIcon}
                    title="Running now"
                    count={runningShown.length}
                    tint="text-sky-400"
                  >
                    {runningShown.length === 0 ? (
                      <EmptyPanelRow>
                        {needle
                          ? "No running looms match your filter."
                          : "Nothing weaving. Start a loom and watch it run."}
                      </EmptyPanelRow>
                    ) : (
                      <div className="divide-y divide-border">
                        {runningShown.map((l) => (
                          <RunningRow key={l.id} loom={l} />
                        ))}
                      </div>
                    )}
                  </Panel>

                  <Panel
                    icon={TriangleAlertIcon}
                    title="Needs you"
                    count={needsYouShown.length}
                    tint="text-amber-400"
                  >
                    {needsYouShown.length === 0 ? (
                      <EmptyPanelRow>
                        Nothing waiting on a decision.
                      </EmptyPanelRow>
                    ) : (
                      <div className="divide-y divide-border">
                        {needsYouShown.map((l) => (
                          <AttentionRow key={l.id} loom={l} />
                        ))}
                      </div>
                    )}
                  </Panel>
                </div>

                <div className="space-y-4">
                  <Panel
                    icon={MessagesSquareIcon}
                    title="Recent sessions"
                    count={liveSessions.length}
                  >
                    {liveSessions.length === 0 ? (
                      <EmptyPanelRow>
                        <Link
                          href="/projects"
                          className="text-muted-foreground hover:text-foreground"
                        >
                          Start a session from a project →
                        </Link>
                      </EmptyPanelRow>
                    ) : (
                      <div className="divide-y divide-border">
                        {liveSessions.map((s) => (
                          <Link
                            key={s.id}
                            href={`/projects/${encodeURIComponent(s.project ?? "")}/sessions/${s.id}`}
                            className="flex items-center gap-2.5 px-3 py-2 transition-colors hover:bg-muted/40"
                          >
                            <MessagesSquareIcon className="size-4 shrink-0 text-muted-foreground" />
                            <div className="min-w-0 flex-1">
                              <span className="block truncate text-sm">
                                {s.title || "Untitled session"}
                              </span>
                              <span className="block truncate text-xs text-muted-foreground">
                                {s.project}
                              </span>
                            </div>
                            <span className="shrink-0 text-[11px] text-muted-foreground">
                              {fmtAgo(s.updatedAt)}
                            </span>
                          </Link>
                        ))}
                      </div>
                    )}
                  </Panel>

                  <Panel icon={FolderGit2Icon} title="Hot projects">
                    {hotProjects.length === 0 ? (
                      <EmptyPanelRow>
                        <Link
                          href="/projects"
                          className="text-muted-foreground hover:text-foreground"
                        >
                          Browse all projects →
                        </Link>
                      </EmptyPanelRow>
                    ) : (
                      <div className="divide-y divide-border">
                        {hotProjects.map((p) => (
                          <Link
                            key={p.name}
                            href={`/projects/${encodeURIComponent(p.name)}`}
                            className="flex items-center gap-2.5 px-3 py-2 transition-colors hover:bg-muted/40"
                          >
                            <FolderGit2Icon className="size-3.5 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 flex-1 truncate text-sm">
                              {p.name}
                            </span>
                            {p.running > 0 && (
                              <span className="flex items-center gap-1 font-mono text-[11px] text-sky-400 tabular-nums">
                                <ClockIcon className="size-3" />
                                {p.running}
                              </span>
                            )}
                            <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
                              {p.open} open
                            </span>
                          </Link>
                        ))}
                      </div>
                    )}
                  </Panel>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
