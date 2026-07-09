"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  ActivityIcon,
  FolderGit2Icon,
  LayoutDashboardIcon,
  RefreshCwIcon,
  SettingsIcon,
} from "lucide-react";
import type { Loom } from "@telar/core";
import { useAccounts } from "@/lib/use-accounts";
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { StateBadge } from "@/components/common/state-badge";
import { isTerminal } from "@/components/looms/utils";

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

function ringStroke(p: number | null): string {
  if (p == null) return "stroke-sidebar-foreground/20";
  if (p >= 90) return "stroke-destructive";
  if (p >= 70) return "stroke-amber-500";
  return "stroke-primary";
}

function dotClass(p: number | null): string {
  if (p == null) return "bg-sidebar-foreground/20";
  if (p >= 90) return "bg-destructive";
  if (p >= 70) return "bg-amber-500";
  return "bg-primary";
}

function TipRow({ label, window }: { label: string; window?: PlanWindow | null }) {
  if (!window) return null;
  const pct = window.utilization;
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex items-center gap-1.5">
        <span className={`size-1.5 rounded-full ${dotClass(pct)}`} />
        {label}
      </span>
      <span className="font-mono tabular-nums">
        {pct != null ? `${Math.round(pct)}%` : "—"}
        {window.resets_at && <span className="opacity-70"> · {fmtReset(window.resets_at)}</span>}
      </span>
    </div>
  );
}

// Outer ring = 5h session, inner ring = weekly. Hover for numbers.
function PlanRing({
  account,
  snap,
  tier,
}: {
  account: string;
  snap: PlanSnapshot;
  tier?: string;
}) {
  const five = snap.fiveHour?.utilization ?? null;
  const week = snap.sevenDay?.utilization ?? null;
  const size = 30,
    cxy = size / 2,
    sw = 3,
    rOut = 12,
    rIn = 7;
  const circ = (r: number) => 2 * Math.PI * r;
  const off = (r: number, p: number | null) =>
    circ(r) * (1 - Math.min(100, p ?? 0) / 100);
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger className="shrink-0 rounded-full outline-none">
          <svg
            width={size}
            height={size}
            viewBox={`0 0 ${size} ${size}`}
            className="-rotate-90"
          >
            <circle
              cx={cxy}
              cy={cxy}
              r={rOut}
              fill="none"
              strokeWidth={sw}
              className="stroke-sidebar-foreground/10"
            />
            <circle
              cx={cxy}
              cy={cxy}
              r={rIn}
              fill="none"
              strokeWidth={sw}
              className="stroke-sidebar-foreground/10"
            />
            {five != null && (
              <circle
                cx={cxy}
                cy={cxy}
                r={rOut}
                fill="none"
                strokeWidth={sw}
                strokeLinecap="round"
                strokeDasharray={circ(rOut)}
                strokeDashoffset={off(rOut, five)}
                className={ringStroke(five)}
              />
            )}
            {week != null && (
              <circle
                cx={cxy}
                cy={cxy}
                r={rIn}
                fill="none"
                strokeWidth={sw}
                strokeLinecap="round"
                strokeDasharray={circ(rIn)}
                strokeDashoffset={off(rIn, week)}
                className={ringStroke(week)}
              />
            )}
          </svg>
        </TooltipTrigger>
        <TooltipContent side="right" className="w-auto flex-col items-stretch gap-1">
          <div className="flex items-center gap-1.5 font-mono text-xs font-medium">
            {account}
            {snap.subscriptionType && (
              <span className="uppercase opacity-70">{snap.subscriptionType}</span>
            )}
            {tier && <span className="opacity-70">{tier}</span>}
          </div>
          <div className="space-y-0.5 text-xs">
            <TipRow label="5-hour session" window={snap.fiveHour} />
            <TipRow label="Weekly · all" window={snap.sevenDay} />
            <TipRow label="Weekly · Opus" window={snap.sevenDayOpus} />
            <TipRow label="Weekly · Sonnet" window={snap.sevenDaySonnet} />
            {snap.modelScoped?.map((w) => (
              <TipRow key={w.display_name} label={`Weekly · ${w.display_name}`} window={w} />
            ))}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function PlanBlock({
  account,
  snap,
  tier,
}: {
  account: string;
  snap: PlanSnapshot;
  tier?: string; // hand-set cosmetic label (e.g. "20x"), undefined until filled in
}) {
  return (
    <div className="flex items-center gap-2">
      <PlanRing account={account} snap={snap} tier={tier} />
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="truncate font-mono text-xs text-sidebar-foreground/70">
          {account}
        </span>
        {snap.subscriptionType && (
          <span className="shrink-0 rounded bg-sidebar-accent px-1 font-mono text-[9px] uppercase">
            {snap.subscriptionType}
          </span>
        )}
        {tier && (
          <span className="shrink-0 font-mono text-[9px] text-sidebar-foreground/50">
            {tier}
          </span>
        )}
      </div>
    </div>
  );
}

const NAV = [
  { href: "/", label: "Dashboard", icon: LayoutDashboardIcon },
  { href: "/projects", label: "Projects", icon: FolderGit2Icon },
  { href: "/looms", label: "Looms", icon: ActivityIcon },
  { href: "/settings", label: "Settings", icon: SettingsIcon },
] as const;

function NavGroup({ activeLooms }: { activeLooms: number }) {
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
                {href === "/looms" && activeLooms > 0 && (
                  <SidebarMenuBadge className="animate-pulse bg-primary text-primary-foreground">
                    {activeLooms}
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

function ActiveLoomsGroup({ looms }: { looms: Loom[] }) {
  const router = useRouter();
  const pathname = usePathname();
  if (looms.length === 0) return null;
  return (
    <SidebarGroup>
      <SidebarGroupLabel>Active looms</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {looms.map((loom) => (
            <SidebarMenuItem key={loom.id}>
              <SidebarMenuButton
                isActive={pathname === `/looms/${loom.id}`}
                onClick={() => router.push(`/looms/${loom.id}`)}
                title={loom.title}
              >
                <StateBadge
                  state={loom.state}
                  className="shrink-0 gap-1 px-1.5 py-0 text-[10px]"
                />
                <span className="truncate text-xs">{loom.title}</span>
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
// with a loom in flight. Hidden entirely when there are no projects.
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
  const { accounts } = useAccounts();
  const tierOf = (name: string) => accounts.find((a) => a.name === name)?.displayTier;
  const [looms, setLooms] = useState<Loom[]>([]);
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

  // Self-fetching: active looms, per-project recency inputs (chats + projects),
  // and plan usage — refreshed on mount, on the global "telar:refresh" signal,
  // and on a slow interval as a safety net.
  const loadAll = useCallback(() => {
    fetch("/api/looms")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setLooms(Array.isArray(d.looms) ? d.looms : []))
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
    if (autoRefreshed.current || accounts.length === 0) return;
    autoRefreshed.current = true;
    const names = accounts.map((a) => a.name);
    void refetchUsage().then((p) => {
      const now = Date.now();
      const stale = names.some((account) => {
        const snap = p[account];
        return !snap || now - snap.capturedAt > PLAN_STALE_MS;
      });
      if (stale) void runRefresh();
    });
  }, [accounts, refetchUsage, runRefresh]);

  const activeLooms = looms.filter((r) => !isTerminal(r.state));
  const activeProjectNames = new Set(activeLooms.map((r) => r.project));

  // Recency per project = the freshest touch (chat or loom); projects with no
  // activity fall back to when they were registered. Take the 5 most recent.
  const recency = new Map<string, number>();
  const bump = (name: string, ts: number) =>
    recency.set(name, Math.max(recency.get(name) ?? 0, ts));
  for (const c of chats) if (c.project) bump(c.project, c.updatedAt);
  for (const r of looms) bump(r.project, r.updatedAt);
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
        <NavGroup activeLooms={activeLooms.length} />
        <ActiveLoomsGroup looms={activeLooms} />
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
              <PlanBlock key={account} account={account} snap={snap} tier={tierOf(account)} />
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
