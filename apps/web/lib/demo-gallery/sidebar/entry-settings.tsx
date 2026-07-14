"use client";

import {
  ActivityIcon,
  FolderGit2Icon,
  LayoutDashboardIcon,
  SettingsIcon,
} from "lucide-react";
import { SidebarRedesign } from "./sidebar-shell";
import { DemoStage } from "./theme-frame";

// The current arrangement: Settings sits as the 4th item in the TOP nav group,
// buried among navigation and easy to hit by accident while reaching for Looms.
function CurrentSidebar() {
  const nav = [
    { label: "Dashboard", icon: LayoutDashboardIcon },
    { label: "Projects", icon: FolderGit2Icon },
    { label: "Looms", icon: ActivityIcon },
    { label: "Settings", icon: SettingsIcon, flag: true },
  ];
  return (
    <div className="flex h-[520px] w-60 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="flex h-14 items-center border-b border-sidebar-border px-4">
        <span className="font-heading text-lg font-semibold tracking-tight">telar</span>
      </div>
      <div className="flex flex-1 flex-col gap-0.5 p-2">
        {nav.map(({ label, icon: Icon, flag }) => (
          <div
            key={label}
            className={`relative flex items-center gap-2 rounded-md p-2 text-sm hover:bg-sidebar-accent ${flag ? "ring-1 ring-inset ring-destructive/50" : ""}`}
          >
            <Icon className="size-4 shrink-0" />
            <span>{label}</span>
            {flag && (
              <span className="ml-auto rounded bg-destructive/15 px-1.5 text-[10px] font-medium text-destructive">
                top nav
              </span>
            )}
          </div>
        ))}
      </div>
      <div className="border-t border-sidebar-border p-3 text-xs text-sidebar-foreground/50">Plan usage…</div>
    </div>
  );
}

// Concern 7 — move Settings out of the top nav to a dedicated slot pinned to the
// sidebar bottom (below plan usage), the conventional home for account/config
// entry points and out of the primary-navigation flow.
export function SidebarSettingsDemo() {
  return (
    <DemoStage>
      {() => (
        <div className="mx-auto flex max-w-4xl flex-col gap-6">
          <div className="flex flex-wrap items-start gap-10">
            <div className="flex flex-col gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Current — Settings in top nav
              </span>
              <div className="overflow-hidden rounded-xl border border-border">
                <CurrentSidebar />
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-foreground">
                Redesigned — Settings at the bottom
              </span>
              <div className="h-[520px] overflow-hidden rounded-xl border border-border">
                <div className="h-full [&>div]:h-full">
                  <SidebarRedesign />
                </div>
              </div>
            </div>
          </div>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Same gear, new home. The top nav is left with the three surfaces you actually
            navigate between (Dashboard, Projects, Looms); Settings anchors the footer beneath
            plan usage, where it stays reachable in both expanded and collapsed states.
          </p>
        </div>
      )}
    </DemoStage>
  );
}
