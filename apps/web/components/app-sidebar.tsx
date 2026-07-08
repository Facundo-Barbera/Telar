"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  ActivityIcon,
  FolderGit2Icon,
  LayoutDashboardIcon,
} from "lucide-react";
import type { Run } from "@telar/core";
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
import { Progress } from "@/components/ui/progress";
import { StateBadge } from "@/components/common/state-badge";
import { isTerminal } from "@/components/runs/utils";

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

// The chat-list shape GET /api/chats returns (a message-less Chat plus a last-
// message preview). Declared locally so this client bundle never pulls in the
// fs-backed store. `preview` may be absent on an older API — tolerated below.
type SessionMeta = {
  id: string;
  title: string;
  project?: string;
  updatedAt: number;
  preview?: string;
};

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
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-sidebar-foreground/70">
          Plan · {account}
        </span>
        {snap.subscriptionType && (
          <span className="rounded bg-sidebar-accent px-1.5 py-0.5 font-mono text-[10px] uppercase">
            {snap.subscriptionType}
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

function SessionsGroup({ sessions }: { sessions: SessionMeta[] }) {
  const router = useRouter();
  const pathname = usePathname();
  if (sessions.length === 0) return null;
  return (
    <SidebarGroup>
      <SidebarGroupLabel>Sessions</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {sessions.map((s) => {
            const href = `/projects/${encodeURIComponent(s.project ?? "")}/sessions/${s.id}`;
            const title = s.title || "Untitled session";
            return (
              <SidebarMenuItem key={s.id}>
                <SidebarMenuButton
                  isActive={pathname === href}
                  onClick={() => router.push(href)}
                  title={title}
                  className="h-auto flex-col items-start gap-0.5 py-1.5"
                >
                  <span className="w-full truncate text-xs">{title}</span>
                  <span className="w-full truncate font-mono text-[10px] text-sidebar-foreground/50">
                    {s.project}
                  </span>
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
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [plan, setPlan] = useState<Record<string, PlanSnapshot>>({});
  const [ledger, setLedger] = useState<{
    session: UsageWindow;
    weekly: UsageWindow;
  } | null>(null);

  // Self-fetching: active runs, recent sessions + plan usage, refreshed on
  // mount, on the global "telar:refresh" signal, and on a slow interval as a
  // safety net.
  const loadAll = useCallback(() => {
    fetch("/api/runs")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setRuns(Array.isArray(d.runs) ? d.runs : []))
      .catch(() => {});
    // Chats arrive newest-first; keep the 5 most recent that anchor to a
    // project (only those have a session page to link into).
    fetch("/api/chats")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        const chats: SessionMeta[] = Array.isArray(d.chats) ? d.chats : [];
        setSessions(chats.filter((c) => c.project).slice(0, 5));
      })
      .catch(() => {});
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

  const activeRuns = runs.filter((r) => !isTerminal(r.state));
  const planEntries = Object.entries(plan).sort(([a], [b]) =>
    a === "personal" ? -1 : b === "personal" ? 1 : a.localeCompare(b),
  );

  return (
    <>
      <SidebarContent>
        <NavGroup activeRuns={activeRuns.length} />
        <ActiveRunsGroup runs={activeRuns} />
        <SessionsGroup sessions={sessions} />
      </SidebarContent>

      <SidebarFooter className="border-t">
        <div className="space-y-3 p-2">
          {planEntries.length > 0 ? (
            planEntries.map(([account, snap]) => (
              <PlanBlock key={account} account={account} snap={snap} />
            ))
          ) : (
            <p className="text-xs text-sidebar-foreground/50">
              Plan usage appears after your first turn.
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
