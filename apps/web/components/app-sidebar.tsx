"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ActivityIcon,
  FolderGit2Icon,
  MessageSquareIcon,
  MessagesSquareIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";

type ChatMeta = {
  id: string;
  title: string;
  model: string;
  account: string;
  updatedAt: number;
  costUsd: number;
};

type UsageWindow = {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  requests: number;
};

type PlanWindow = { utilization: number | null; resets_at: string | null };

type PlanSnapshot = {
  capturedAt: number;
  subscriptionType: string | null;
  fiveHour?: PlanWindow | null;
  sevenDay?: PlanWindow | null;
  sevenDayOpus?: PlanWindow | null;
  sevenDaySonnet?: PlanWindow | null;
  modelScoped?: { display_name: string; utilization: number | null; resets_at: string | null }[];
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
            <span className="text-sidebar-foreground/50"> · resets {fmtReset(window.resets_at)}</span>
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

function groupLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  if (today.getTime() - ts < 7 * 86_400_000) return "This week";
  return "Older";
}

const NAV = [
  { href: "/", label: "Chat", icon: MessagesSquareIcon },
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
            const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
            return (
              <SidebarMenuItem key={href}>
                <SidebarMenuButton isActive={active} onClick={() => router.push(href)}>
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

function TelarSidebarHeader() {
  const router = useRouter();
  return (
    <SidebarHeader className="border-b">
      <div className="flex items-center justify-between px-2 py-1">
        <span className="font-heading text-lg font-semibold tracking-tight">telar</span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => router.push("/")}
          title="New thread"
        >
          <PlusIcon className="size-4" />
        </Button>
      </div>
    </SidebarHeader>
  );
}

function SidebarLoadingBody() {
  return (
    <>
      <SidebarContent>
        <NavGroup activeRuns={0} />
      </SidebarContent>
      <SidebarFooter className="border-t">
        <div className="space-y-3 p-2">
          <span className="text-xs font-medium text-sidebar-foreground/70">Plan usage</span>
          <p className="text-xs text-sidebar-foreground/50">Loading usage…</p>
        </div>
      </SidebarFooter>
    </>
  );
}

function SidebarBody() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeChatId = searchParams.get("chat");

  const [chats, setChats] = useState<ChatMeta[]>([]);
  const [plan, setPlan] = useState<Record<string, PlanSnapshot>>({});
  const [ledger, setLedger] = useState<{ session: UsageWindow; weekly: UsageWindow } | null>(null);
  const [activeRuns, setActiveRuns] = useState(0);
  // The chat composer broadcasts its live account choice; follow it so the plan
  // footer never drifts from the dropdown (falls back to the saved chat value).
  const [composerAccount, setComposerAccount] = useState<string | null>(null);

  // Self-fetching: chats + usage + active runs, refreshed on mount, on the
  // global "telar:refresh" signal, and on a slow interval as a safety net.
  const loadAll = useCallback(() => {
    fetch("/api/chats")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setChats(d.chats ?? []))
      .catch(() => {});
    fetch("/api/usage")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setPlan(d.plan ?? {});
        setLedger(d.ledger ?? null);
      })
      .catch(() => {});
    fetch("/api/runs")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setActiveRuns(Array.isArray(d.active) ? d.active.length : 0))
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

  useEffect(() => {
    const onAccount = (e: Event) =>
      setComposerAccount((e as CustomEvent<string>).detail);
    window.addEventListener("telar:account", onAccount);
    return () => window.removeEventListener("telar:account", onAccount);
  }, []);

  const removeChat = useCallback(
    async (id: string) => {
      await fetch(`/api/chats/${id}`, { method: "DELETE" });
      if (id === activeChatId) router.push("/");
      window.dispatchEvent(new Event("telar:refresh"));
    },
    [activeChatId, router],
  );

  const account =
    composerAccount ?? chats.find((c) => c.id === activeChatId)?.account ?? "personal";
  const activePlan = plan[account] ?? null;

  const groups = new Map<string, ChatMeta[]>();
  for (const chat of chats) {
    const label = groupLabel(chat.updatedAt);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(chat);
  }

  return (
    <>
      <SidebarContent>
        <NavGroup activeRuns={activeRuns} />
        {chats.length === 0 && (
          <div className="px-4 py-6 text-center text-xs text-sidebar-foreground/50">
            No threads yet — weave your first one.
          </div>
        )}
        {[...groups.entries()].map(([label, items]) => (
          <SidebarGroup key={label}>
            <SidebarGroupLabel>{label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {items.map((chat) => (
                  <SidebarMenuItem key={chat.id}>
                    <SidebarMenuButton
                      isActive={chat.id === activeChatId}
                      onClick={() => router.push("/?chat=" + chat.id)}
                      className="pr-8"
                    >
                      <MessageSquareIcon className="size-4 shrink-0" />
                      <span className="truncate">{chat.title}</span>
                    </SidebarMenuButton>
                    <SidebarMenuAction
                      showOnHover
                      onClick={(e) => {
                        e.stopPropagation();
                        void removeChat(chat.id);
                      }}
                      title="Delete thread"
                    >
                      <Trash2Icon className="size-3.5" />
                    </SidebarMenuAction>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter className="border-t">
        <div className="space-y-3 p-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-sidebar-foreground/70">
              Plan usage · {account}
            </span>
            {activePlan?.subscriptionType && (
              <span className="rounded bg-sidebar-accent px-1.5 py-0.5 font-mono text-[10px] uppercase">
                {activePlan.subscriptionType}
              </span>
            )}
          </div>
          {activePlan ? (
            <>
              {activePlan.fiveHour && <PlanMeter label="Session · 5h" window={activePlan.fiveHour} />}
              {activePlan.sevenDay && (
                <PlanMeter label="Weekly · all models" window={activePlan.sevenDay} />
              )}
              {activePlan.sevenDayOpus && (
                <PlanMeter label="Weekly · Opus" window={activePlan.sevenDayOpus} />
              )}
              {activePlan.sevenDaySonnet && (
                <PlanMeter label="Weekly · Sonnet" window={activePlan.sevenDaySonnet} />
              )}
              {activePlan.modelScoped?.map((w) => (
                <PlanMeter key={w.display_name} label={`Weekly · ${w.display_name}`} window={w} />
              ))}
            </>
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
      <Suspense fallback={<SidebarLoadingBody />}>
        <SidebarBody />
      </Suspense>
    </Sidebar>
  );
}
