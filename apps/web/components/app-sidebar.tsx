"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  ActivityIcon,
  FolderGit2Icon,
  LayoutDashboardIcon,
  RefreshCwIcon,
} from "lucide-react";
import type { Run } from "@telar/core";
import { ACCOUNTS } from "@/lib/accounts";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { StateBadge } from "@/components/common/state-badge";
import { isTerminal } from "@/components/runs/utils";

// Auto-refresh plan usage on mount when a snapshot is missing or older than
// this — keeps the sidebar honest without a manual click.
const PLAN_STALE_MS = 30 * 60 * 1000;

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

type UsageWindow = {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  requests: number;
};

// Chats and projects only feed per-project recency in the sidebar now (no rows
// rendered for them), so we keep just the fields recency needs. Declared
// locally so this client bundle never pulls in the fs-backed store.
type ChatMeta = { project?: string; updatedAt: number };
type ProjectMeta = { entry: { name: string; addedAt: number } };
type RecentProject = { name: string; active: boolean };

function fmtReset(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return time;
  return `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

function PlanMeter({ label, window }: { label: string; window: PlanWindow }) {
  const pct = window.utilization ?? 0;
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-sidebar-foreground/70">{label}</span>
        <span className="font-mono">
          {window.utilization != null ? `${Math.round(pct)}%` : "—"}
          {window.resets_at && (
            <span className="text-sidebar-foreground/50">
              {" "}
              · resets {fmtReset(window.resets_at)}
            </span>
          )}
        </span>
      </div>
      <Progress
        value={Math.min(100, pct)}
        className={`h-1 ${pct >= 90 ? "[&>[data-slot=progress-indicator]]:bg-destructive" : ""}`}
      />
    </div>
  );
}

function PlanBlock({ account, snap }: { account: string; snap: PlanSnapshot }) {
  // A hand-set cosmetic label (e.g. "20x") — undefined until the user fills it in.
  const tier = ACCOUNTS[account]?.displayTier;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-xs font-medium text-sidebar-foreground/70">
          {account}
        </span>
        {(snap.subscriptionType || tier) && (
          <span className="flex shrink-0 items-center gap-1">
            {snap.subscriptionType && (
              <span className="rounded bg-sidebar-accent px-1.5 py-0.5 font-mono text-[10px] uppercase">
                {snap.subscriptionType}
              </span>
            )}
            {tier && (
              <span className="font-mono text-[10px] text-sidebar-foreground/50">
                {tier}
              </span>
            )}
          </span>
        )}
      </div>
      {snap.fiveHour && <PlanMeter label="Session · 5h" window={snap.fiveHour} />}
      {snap.sevenDay && (
        <PlanMeter label="Weekly · all models" window={snap.sevenDay} />
      )}
      {snap.sevenDayOpus && (
        <PlanMeter label="Weekly · Opus" window={snap.sevenDayOpus} />
      )}
      {snap.sevenDaySonnet && (
        <PlanMeter label="Weekly · Sonnet" window={snap.sevenDaySonnet} />
      )}
      {snap.modelScoped?.map((w) => (
        <PlanMeter key={w.display_name} label={`Weekly · ${w.display_name}`} window={w} />
      ))}
    </div>
  );
}

const NAV = [
  { href: "/", label: "Dashboard", icon: LayoutDashboardIcon },
  { href: "/projects", label: "Projects", icon: FolderGit2Icon },
  { href: "/runs", label: "Runs", icon: ActivityIcon },
] as const;

function NavGroup({ activeRuns }: { activeRuns: number }) {
  const router = useRouter();
  const pathname = usePathname();
  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu>
          {NAV.map(({ href, label, icon: Icon }) => {
            const active =
              href === "/" ? pathname === "/" : pathname.startsWith(href);
            return (
              <SidebarMenuItem key={href}>
                <SidebarMenuButton
                  isActive={active}
                  onClick={() => router.push(href)}
                >
                  <Icon className="size-4 shrink-0" />
                  <span>{label}</span>
                </SidebarMenuButton>
                {href === "/runs" && activeRuns > 0 && (
                  <SidebarMenuBadge className="animate-pulse bg-primary text-primary-foreground">
                    {activeRuns}
                  </SidebarMenuBadge>
                )}
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function ActiveRunsGroup({ runs }: { runs: Run[] }) {
  const router = useRouter();
  const pathname = usePathname();
  if (runs.length === 0) return null;
  return (
    <SidebarGroup>
      <SidebarGroupLabel>Active runs</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {runs.map((run) => (
            <SidebarMenuItem key={run.id}>
              <SidebarMenuButton
                isActive={pathname === `/runs/${run.id}`}
                onClick={() => router.push(`/runs/${run.id}`)}
                title={run.title}
              >
                <StateBadge
                  state={run.state}
                  className="shrink-0 gap-1 px-1.5 py-0 text-[10px]"
                />
                <span className="truncate text-xs">{run.title}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

// The 5 most recently touched projects — sessions now live inside a project, so
// this replaces the old flat "Sessions" list. A pulsing dot marks a project
// with a run in flight. Hidden entirely when there are no projects.
function RecentProjectsGroup({ projects }: { projects: RecentProject[] }) {
  const pathname = usePathname();
  if (projects.length === 0) return null;
  return (
    <SidebarGroup>
      <SidebarGroupLabel>Recent projects</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {projects.map((p) => {
            const href = `/projects/${encodeURIComponent(p.name)}`;
            return (
              <SidebarMenuItem key={p.name}>
                <SidebarMenuButton
                  isActive={pathname === href}
                  title={p.name}
                  render={<Link href={href} />}
                >
                  <FolderGit2Icon className="size-4 shrink-0" />
                  <span className="truncate">{p.name}</span>
                  {p.active && (
                    <span
                      aria-hidden
                      className="ml-auto size-1.5 shrink-0 animate-pulse rounded-full bg-primary"
                    />
                  )}
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function TelarSidebarHeader() {
  const router = useRouter();
  return (
    <SidebarHeader className="border-b">
      <button
        type="button"
        onClick={() => router.push("/")}
        className="flex items-center px-2 py-1 text-left outline-none"
      >
        <span className="font-heading text-lg font-semibold tracking-tight">
          telar
        </span>
      </button>
    </SidebarHeader>
  );
}

function SidebarBody() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [chats, setChats] = useState<ChatMeta[]>([]);
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [plan, setPlan] = useState<Record<string, PlanSnapshot>>({});
  const [ledger, setLedger] = useState<{
    session: UsageWindow;
    weekly: UsageWindow;
  } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const autoRefreshed = useRef(false);

  // Re-reads the stored snapshots (fast, no subprocess) and returns them so
  // callers can reason about staleness.
  const refetchUsage = useCallback(async (): Promise<
    Record<string, PlanSnapshot>
  > => {
    try {
      const r = await fetch("/api/usage");
      if (!r.ok) return {};
      const d = await r.json();
      const p: Record<string, PlanSnapshot> = d.plan ?? {};
      setPlan(p);
      setLedger(d.ledger ?? null);
      return p;
    } catch {
      return {};
    }
  }, []);

  // Captures fresh plan usage for every account (POST spawns a short-lived SDK
  // probe server-side), then re-reads the stored snapshots and broadcasts so
  // sibling surfaces (dashboard) pick up the new numbers too.
  const runRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetch("/api/usage/refresh", { method: "POST" });
    } catch {
      // best-effort — refetchUsage below surfaces whatever landed
    } finally {
      await refetchUsage();
      setRefreshing(false);
      window.dispatchEvent(new Event("telar:refresh"));
    }
  }, [refetchUsage]);

  // Self-fetching: active runs, per-project recency inputs (chats + projects),
  // and plan usage — refreshed on mount, on the global "telar:refresh" signal,
  // and on a slow interval as a safety net.
  const loadAll = useCallback(() => {
    fetch("/api/runs")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setRuns(Array.isArray(d.runs) ? d.runs : []))
      .catch(() => {});
    // Chats feed per-project recency only (no rows rendered) — keep just those
    // that anchor to a project.
    fetch("/api/chats")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        const list: ChatMeta[] = Array.isArray(d.chats) ? d.chats : [];
        setChats(list.filter((c) => c.project));
      })
      .catch(() => {});
    fetch("/api/projects")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setProjects(Array.isArray(d.projects) ? d.projects : []);
      })
      .catch(() => {});
    // Inlined rather than delegating to refetchUsage: this effect re-runs on
    // every mount/interval/telar:refresh tick, and the lint rule against
    // setState-in-effect can't see through a helper that sets state after an
    // `await` unless the fetch chain is visible right here at the call site.
    fetch("/api/usage")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setPlan(d.plan ?? {});
        setLedger(d.ledger ?? null);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadAll();
    window.addEventListener("telar:refresh", loadAll);
    const t = setInterval(loadAll, 10_000);
    return () => {
      window.removeEventListener("telar:refresh", loadAll);
      clearInterval(t);
    };
  }, [loadAll]);

  // Once, on mount: if any account is missing a snapshot or its snapshot has
  // gone stale, capture fresh usage automatically. Ref-guarded so it fires a
  // single time regardless of re-renders or the load interval.
  useEffect(() => {
    if (autoRefreshed.current) return;
    autoRefreshed.current = true;
    void refetchUsage().then((p) => {
      const now = Date.now();
      const stale = Object.keys(ACCOUNTS).some((account) => {
        const snap = p[account];
        return !snap || now - snap.capturedAt > PLAN_STALE_MS;
      });
      if (stale) void runRefresh();
    });
  }, [refetchUsage, runRefresh]);

  const activeRuns = runs.filter((r) => !isTerminal(r.state));
  const activeProjectNames = new Set(activeRuns.map((r) => r.project));

  // Recency per project = the freshest touch (chat or run); projects with no
  // activity fall back to when they were registered. Take the 5 most recent.
  const recency = new Map<string, number>();
  const bump = (name: string, ts: number) =>
    recency.set(name, Math.max(recency.get(name) ?? 0, ts));
  for (const c of chats) if (c.project) bump(c.project, c.updatedAt);
  for (const r of runs) bump(r.project, r.updatedAt);
  const recentProjects: RecentProject[] = projects
    .map((p) => ({
      name: p.entry.name,
      activity: recency.get(p.entry.name) ?? p.entry.addedAt,
      active: activeProjectNames.has(p.entry.name),
    }))
    .sort((a, b) => b.activity - a.activity)
    .slice(0, 5)
    .map(({ name, active }) => ({ name, active }));

  const planEntries = Object.entries(plan).sort(([a], [b]) =>
    a === "personal" ? -1 : b === "personal" ? 1 : a.localeCompare(b),
  );

  return (
    <>
      <SidebarContent>
        <NavGroup activeRuns={activeRuns.length} />
        <ActiveRunsGroup runs={activeRuns} />
        <RecentProjectsGroup projects={recentProjects} />
      </SidebarContent>

      <SidebarFooter className="border-t">
        <div className="space-y-3 p-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-sidebar-foreground/70">
              Plan usage
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => void runRefresh()}
              disabled={refreshing}
              aria-label="Refresh plan usage"
              title="Refresh plan usage"
              className="-my-1 text-sidebar-foreground/60 hover:text-sidebar-foreground"
            >
              <RefreshCwIcon className={refreshing ? "animate-spin" : undefined} />
            </Button>
          </div>
          {planEntries.length > 0 ? (
            planEntries.map(([account, snap]) => (
              <PlanBlock key={account} account={account} snap={snap} />
            ))
          ) : (
            <p className="text-xs text-sidebar-foreground/50">
              {refreshing
                ? "Fetching plan usage…"
                : "No usage captured yet — refresh to fetch it."}
            </p>
          )}
          {ledger && (
            <p className="font-mono text-[10px] text-sidebar-foreground/40">
              telar-measured: ${ledger.session.costUsd.toFixed(2)} / 5h ·{" "}
              ${ledger.weekly.costUsd.toFixed(2)} / wk
            </p>
          )}
        </div>
      </SidebarFooter>
    </>
  );
}

export function AppSidebar() {
  return (
    <Sidebar>
      <TelarSidebarHeader />
      <SidebarBody />
    </Sidebar>
  );
}
