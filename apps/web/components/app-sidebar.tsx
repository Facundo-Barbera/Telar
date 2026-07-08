"use client";

import { MessageSquareIcon, PlusIcon, Trash2Icon } from "lucide-react";
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
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";

export type ChatMeta = {
  id: string;
  title: string;
  model: string;
  account: string;
  updatedAt: number;
  costUsd: number;
};

export type UsageWindow = {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  requests: number;
};

export type PlanWindow = { utilization: number | null; resets_at: string | null };

export type PlanSnapshot = {
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

export function AppSidebar({
  chats,
  activeId,
  plan,
  ledger,
  account,
  onSelect,
  onNew,
  onDelete,
}: {
  chats: ChatMeta[];
  activeId: string | null;
  plan: PlanSnapshot | null;
  ledger: { session: UsageWindow; weekly: UsageWindow } | null;
  account: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}) {
  const groups = new Map<string, ChatMeta[]>();
  for (const chat of chats) {
    const label = groupLabel(chat.updatedAt);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(chat);
  }

  return (
    <Sidebar>
      <SidebarHeader className="border-b">
        <div className="flex items-center justify-between px-2 py-1">
          <span className="font-heading text-lg font-semibold tracking-tight">
            telar
          </span>
          <Button variant="ghost" size="icon-sm" onClick={onNew} title="New thread">
            <PlusIcon className="size-4" />
          </Button>
        </div>
      </SidebarHeader>

      <SidebarContent>
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
                      isActive={chat.id === activeId}
                      onClick={() => onSelect(chat.id)}
                      className="pr-8"
                    >
                      <MessageSquareIcon className="size-4 shrink-0" />
                      <span className="truncate">{chat.title}</span>
                    </SidebarMenuButton>
                    <SidebarMenuAction
                      showOnHover
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(chat.id);
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
            {plan?.subscriptionType && (
              <span className="rounded bg-sidebar-accent px-1.5 py-0.5 font-mono text-[10px] uppercase">
                {plan.subscriptionType}
              </span>
            )}
          </div>
          {plan ? (
            <>
              {plan.fiveHour && <PlanMeter label="Session · 5h" window={plan.fiveHour} />}
              {plan.sevenDay && <PlanMeter label="Weekly · all models" window={plan.sevenDay} />}
              {plan.sevenDayOpus && <PlanMeter label="Weekly · Opus" window={plan.sevenDayOpus} />}
              {plan.sevenDaySonnet && (
                <PlanMeter label="Weekly · Sonnet" window={plan.sevenDaySonnet} />
              )}
              {plan.modelScoped?.map((w) => (
                <PlanMeter
                  key={w.display_name}
                  label={`Weekly · ${w.display_name}`}
                  window={w}
                />
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
    </Sidebar>
  );
}
