"use client";

// Standalone re-implementation of the Telar sidebar chrome for the redesign
// demos. It mirrors the production AppSidebar's visual language (bg-sidebar
// tokens, rounded-md rows, group labels, plan-usage rings) but is a self-owned
// COPY so it can be fully interactive inside the demo stage without pulling in
// SidebarProvider's fixed-positioning shell. Only token classes are used (no
// `dark:` variants) so ThemeSurface controls light/dark.
import { useState } from "react";
import {
  ActivityIcon,
  ChevronRightIcon,
  FolderGit2Icon,
  LayoutDashboardIcon,
  MessageSquareIcon,
  PanelLeftIcon,
  PinIcon,
  PinOffIcon,
  SettingsIcon,
} from "lucide-react";
import { StateBadge } from "@/components/common/state-badge";
import type { WorkUnitState } from "@telar/core";
import { AccountWheels } from "./account-wheels";
import {
  activeFirst,
  activeLoomCount,
  PINNED,
  RECENTS,
  type DemoProject,
} from "./fixtures";

// ── shared bits ──────────────────────────────────────────────────────────

function GroupLabel({
  children,
  action,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-7 items-center justify-between px-2 text-xs font-medium text-sidebar-foreground/60">
      <span className="flex items-center gap-1.5">{children}</span>
      {action}
    </div>
  );
}

// One initial-avatar for collapsed rail + a running pulse.
function ProjectGlyph({ name, running }: { name: string; running: boolean }) {
  return (
    <span className="relative flex size-7 shrink-0 items-center justify-center rounded-md bg-sidebar-accent text-[11px] font-semibold text-sidebar-accent-foreground uppercase">
      {name.slice(0, 2)}
      {running && (
        <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-primary ring-2 ring-sidebar animate-pulse" />
      )}
    </span>
  );
}

function loomTone(state: WorkUnitState): string {
  if (state === "blocked" || state === "needs-review") return "bg-amber-400";
  if (state === "failed") return "bg-destructive";
  if (state === "ready") return "bg-emerald-400";
  return "bg-primary";
}

// ── project row with nested today (chats + active looms) ─────────────────

function ProjectRow({
  project,
  pinned,
  highlighted,
  onTogglePin,
}: {
  project: DemoProject;
  pinned: boolean;
  highlighted?: boolean;
  onTogglePin: () => void;
}) {
  const nested = project.todayChats.length + project.looms.length;
  const [open, setOpen] = useState(highlighted ?? false);
  const running = project.looms.length > 0;

  return (
    <div className="group/proj">
      <div
        className={`relative flex items-center rounded-md ${
          highlighted ? "bg-sidebar-accent/60" : "hover:bg-sidebar-accent"
        }`}
      >
        {highlighted && (
          <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-primary" />
        )}
        {/* expand toggle */}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          disabled={nested === 0}
          className="flex size-7 items-center justify-center rounded-md text-sidebar-foreground/40 disabled:opacity-0"
          aria-label={open ? "Collapse" : "Expand"}
        >
          <ChevronRightIcon className={`size-3.5 transition-transform ${open ? "rotate-90" : ""}`} />
        </button>
        {/* project link */}
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-1 text-left text-sm"
        >
          <FolderGit2Icon className="size-4 shrink-0 text-sidebar-foreground/70" />
          <span className="truncate">{project.name}</span>
          {running && (
            <span className="flex shrink-0 items-center gap-1">
              <span className="size-1.5 animate-pulse rounded-full bg-primary" />
              {project.looms.length > 1 && (
                <span className="font-mono text-[10px] text-sidebar-foreground/50">
                  {project.looms.length}
                </span>
              )}
            </span>
          )}
        </button>
        {/* pin toggle (hover) */}
        <button
          type="button"
          onClick={onTogglePin}
          className="mr-1 flex size-6 items-center justify-center rounded text-sidebar-foreground/40 opacity-0 transition group-hover/proj:opacity-100 hover:bg-sidebar-accent hover:text-sidebar-foreground"
          aria-label={pinned ? "Unpin" : "Pin"}
          title={pinned ? "Unpin project" : "Pin project"}
        >
          {pinned ? <PinOffIcon className="size-3.5" /> : <PinIcon className="size-3.5" />}
        </button>
      </div>

      {/* nested: today's active looms then today's chats */}
      {open && nested > 0 && (
        <div className="ml-[1.375rem] mt-0.5 flex flex-col gap-0.5 border-l border-sidebar-border pl-2">
          {project.looms.map((l) => (
            <button
              key={l.id}
              type="button"
              className="flex items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-sidebar-accent"
            >
              <StateBadge state={l.state} className="shrink-0 gap-1 px-1.5 py-0 text-[9px]" />
              <span className="truncate text-xs text-sidebar-foreground/80">{l.title}</span>
            </button>
          ))}
          {project.todayChats.map((c) => (
            <button
              key={c.id}
              type="button"
              className="flex items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-sidebar-accent"
            >
              <MessageSquareIcon className="size-3.5 shrink-0 text-sidebar-foreground/40" />
              <span className="truncate text-xs text-sidebar-foreground/80">{c.title}</span>
              {c.running ? (
                <span className="ml-auto size-1.5 shrink-0 animate-pulse rounded-full bg-primary" />
              ) : (
                <span className="ml-auto shrink-0 font-mono text-[10px] text-sidebar-foreground/35">{c.time}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// collapsed-rail glyph row
function RailProject({ project }: { project: DemoProject }) {
  return (
    <button
      type="button"
      title={project.name}
      className="flex items-center justify-center rounded-md p-1.5 hover:bg-sidebar-accent"
    >
      <ProjectGlyph name={project.name} running={project.looms.length > 0} />
    </button>
  );
}

// ── the full sidebar ─────────────────────────────────────────────────────

const NAV = [
  { label: "Dashboard", icon: LayoutDashboardIcon, active: false },
  { label: "Projects", icon: FolderGit2Icon, active: false },
  { label: "Looms", icon: ActivityIcon, active: true },
] as const;

export function SidebarRedesign({ startCollapsed = false }: { startCollapsed?: boolean }) {
  const [collapsed, setCollapsed] = useState(startCollapsed);
  const [pinnedNames, setPinnedNames] = useState<string[]>(PINNED.map((p) => p.name));

  const all = [...PINNED, ...RECENTS];
  const byName = (n: string) => all.find((p) => p.name === n)!;
  const pinned = pinnedNames.map(byName);
  const recents = activeFirst(RECENTS.filter((p) => !pinnedNames.includes(p.name)));
  const looms = activeLoomCount(PINNED, RECENTS);

  const togglePin = (name: string) =>
    setPinnedNames((cur) =>
      cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name],
    );

  // The single most-recent ACTIVE recent project gets the highlight.
  const highlightName = recents.find((p) => p.looms.length > 0)?.name;

  const width = collapsed ? "w-14" : "w-64";

  return (
    <div className={`flex ${width} shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200`}>
      {/* header */}
      <div className="flex h-14 items-center border-b border-sidebar-border px-2">
        {!collapsed && (
          <span className="flex-1 px-2 font-heading text-lg font-semibold tracking-tight">telar</span>
        )}
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className={`flex size-8 items-center justify-center rounded-md text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground ${collapsed ? "mx-auto" : ""}`}
          aria-label="Toggle sidebar"
        >
          <PanelLeftIcon className="size-4" />
        </button>
      </div>

      {/* scroll body */}
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
        {/* primary nav */}
        <div className="flex flex-col gap-0.5">
          {NAV.map(({ label, icon: Icon, active }) => (
            <button
              key={label}
              type="button"
              title={label}
              className={`relative flex items-center gap-2 rounded-md p-2 text-sm ${
                active ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground" : "hover:bg-sidebar-accent"
              } ${collapsed ? "justify-center" : ""}`}
            >
              <Icon className="size-4 shrink-0" />
              {!collapsed && <span className="flex-1 text-left">{label}</span>}
              {label === "Looms" && looms > 0 &&
                (collapsed ? (
                  <span className="absolute right-1 top-1 size-2 animate-pulse rounded-full bg-primary" />
                ) : (
                  <span className="animate-pulse rounded-md bg-primary px-1.5 text-xs font-medium tabular-nums text-primary-foreground">
                    {looms}
                  </span>
                ))}
            </button>
          ))}
        </div>

        {collapsed ? (
          <>
            <div className="my-1 h-px bg-sidebar-border" />
            <div className="flex flex-col items-center gap-1">
              {pinned.map((p) => (
                <RailProject key={p.name} project={p} />
              ))}
            </div>
            <div className="my-1 h-px bg-sidebar-border" />
            <div className="flex flex-col items-center gap-1">
              {recents.map((p) => (
                <RailProject key={p.name} project={p} />
              ))}
            </div>
          </>
        ) : (
          <>
            {/* PINNED */}
            {pinned.length > 0 && (
              <div className="mt-2">
                <GroupLabel>
                  <PinIcon className="size-3.5" /> Pinned
                </GroupLabel>
                <div className="flex flex-col">
                  {pinned.map((p) => (
                    <ProjectRow
                      key={p.name}
                      project={p}
                      pinned
                      onTogglePin={() => togglePin(p.name)}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* RECENTS */}
            <div className="mt-2">
              <GroupLabel>Recent</GroupLabel>
              <div className="flex flex-col">
                {recents.map((p) => (
                  <ProjectRow
                    key={p.name}
                    project={p}
                    pinned={false}
                    highlighted={p.name === highlightName}
                    onTogglePin={() => togglePin(p.name)}
                  />
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      {/* footer: account wheels (compact + reorderable) + settings at BOTTOM */}
      <div className="border-t border-sidebar-border p-2">
        <div className="mb-2">
          <AccountWheels collapsed={collapsed} />
        </div>
        <button
          type="button"
          title="Settings"
          className={`flex w-full items-center gap-2 rounded-md p-2 text-sm text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground ${collapsed ? "justify-center" : ""}`}
        >
          <SettingsIcon className="size-4 shrink-0" />
          {!collapsed && <span>Settings</span>}
        </button>
      </div>
    </div>
  );
}

// A dimmed faux content pane so the sidebar reads in-context beside a page.
export function FauxContent({ label = "Looms" }: { label?: string }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col bg-background">
      <div className="flex h-14 items-center gap-3 border-b border-border px-6">
        <span className="text-base font-semibold">{label}</span>
        <span className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">demo content</span>
      </div>
      <div className="flex-1 space-y-3 p-6 opacity-40">
        {[80, 55, 70, 40, 62].map((w, i) => (
          <div key={i} className="h-10 rounded-lg border border-border bg-card" style={{ width: `${w}%` }} />
        ))}
      </div>
    </div>
  );
}
