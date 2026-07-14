"use client";

import { useState } from "react";
import {
  ChevronRightIcon,
  FolderGit2Icon,
  MessageSquareIcon,
  PinIcon,
} from "lucide-react";
import { StateBadge } from "@/components/common/state-badge";
import { activeFirst, PINNED, RECENTS, type DemoProject } from "./fixtures";
import { DemoStage } from "./theme-frame";

// ── "current" flat recents (mirrors production RecentProjectsGroup) ────────
// Prod: 5 most-recent projects, flat, sorted by recency only, pulse dot if a
// loom is in flight. No pinned section, no nested today.
function CurrentRecents() {
  const rows = [...PINNED, ...RECENTS]
    .slice()
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, 5);
  return (
    <div className="w-60 rounded-lg border border-sidebar-border bg-sidebar p-2 text-sidebar-foreground">
      <div className="flex h-7 items-center px-2 text-xs font-medium text-sidebar-foreground/60">
        Recent projects
      </div>
      <div className="flex flex-col">
        {rows.map((p) => (
          <div key={p.name} className="flex items-center gap-2 rounded-md p-2 text-sm hover:bg-sidebar-accent">
            <FolderGit2Icon className="size-4 shrink-0 text-sidebar-foreground/70" />
            <span className="truncate">{p.name}</span>
            {p.looms.length > 0 && (
              <span className="ml-auto size-1.5 shrink-0 animate-pulse rounded-full bg-primary" />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function rank(p: DemoProject): number {
  const a = p.activity;
  if (a.includes("now") || a.endsWith("s")) return 0;
  if (a.endsWith("m") || a.includes("m ago")) return 1;
  if (a.includes("h")) return 2;
  if (a.includes("yesterday")) return 3;
  return 4;
}

// ── redesigned recents (pinned + active-first + nested today) ──────────────
function Row({ p, highlighted }: { p: DemoProject; highlighted?: boolean }) {
  const nested = p.todayChats.length + p.looms.length;
  const [open, setOpen] = useState(highlighted ?? false);
  return (
    <div>
      <div
        className={`relative flex items-center rounded-md ${highlighted ? "bg-sidebar-accent/60" : "hover:bg-sidebar-accent"}`}
      >
        {highlighted && <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-primary" />}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          disabled={nested === 0}
          className="flex size-7 items-center justify-center rounded-md text-sidebar-foreground/40 disabled:opacity-0"
          aria-label="toggle"
        >
          <ChevronRightIcon className={`size-3.5 transition-transform ${open ? "rotate-90" : ""}`} />
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-2 text-sm">
          <FolderGit2Icon className="size-4 shrink-0 text-sidebar-foreground/70" />
          <span className="truncate">{p.name}</span>
          {p.looms.length > 0 && <span className="size-1.5 animate-pulse rounded-full bg-primary" />}
        </div>
      </div>
      {open && nested > 0 && (
        <div className="ml-[1.375rem] mt-0.5 flex flex-col gap-0.5 border-l border-sidebar-border pl-2">
          {p.looms.map((l) => (
            <div key={l.id} className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-sidebar-accent">
              <StateBadge state={l.state} className="shrink-0 gap-1 px-1.5 py-0 text-[9px]" />
              <span className="truncate text-xs text-sidebar-foreground/80">{l.title}</span>
            </div>
          ))}
          {p.todayChats.map((c) => (
            <div key={c.id} className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-sidebar-accent">
              <MessageSquareIcon className="size-3.5 shrink-0 text-sidebar-foreground/40" />
              <span className="truncate text-xs text-sidebar-foreground/80">{c.title}</span>
              {c.running ? (
                <span className="ml-auto size-1.5 shrink-0 animate-pulse rounded-full bg-primary" />
              ) : (
                <span className="ml-auto font-mono text-[10px] text-sidebar-foreground/35">{c.time}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RedesignedRecents() {
  const recents = activeFirst(RECENTS);
  const highlight = recents.find((p) => p.looms.length > 0)?.name;
  return (
    <div className="w-64 rounded-lg border border-sidebar-border bg-sidebar p-2 text-sidebar-foreground">
      <div className="flex h-7 items-center gap-1.5 px-2 text-xs font-medium text-sidebar-foreground/60">
        <PinIcon className="size-3.5" /> Pinned
      </div>
      <div className="flex flex-col">
        {PINNED.map((p) => (
          <Row key={p.name} p={p} />
        ))}
      </div>
      <div className="mt-2 flex h-7 items-center px-2 text-xs font-medium text-sidebar-foreground/60">Recent</div>
      <div className="flex flex-col">
        {recents.map((p) => (
          <Row key={p.name} p={p} highlighted={p.name === highlight} />
        ))}
      </div>
    </div>
  );
}

function Note({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-2 text-sm text-muted-foreground">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
        {n}
      </span>
      <span>{children}</span>
    </li>
  );
}

// Concern 3 — the recents grouping in isolation, current vs redesigned, so the
// three additive changes (pinned section, active-first ordering, today nested)
// are directly comparable.
export function SidebarRecentsDemo() {
  return (
    <DemoStage>
      {() => (
        <div className="mx-auto flex max-w-4xl flex-col gap-8">
          <div className="flex flex-wrap items-start gap-10">
            <div className="flex flex-col gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Current</span>
              <CurrentRecents />
              <p className="max-w-[15rem] text-xs text-muted-foreground/70">
                Flat list, recency-only. A running loom is a bare dot; no pinning; today's
                chats live in a separate surface entirely.
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-foreground">Redesigned</span>
              <RedesignedRecents />
            </div>
          </div>

          <ol className="max-w-2xl space-y-2">
            <Note n={1}>
              <b className="text-foreground">Pinned section</b> above recents — projects you always
              want reachable, pinned order preserved, unaffected by activity churn.
            </Note>
            <Note n={2}>
              <b className="text-foreground">Last active on top.</b> Recents sort active-first: any
              project with a loom in flight floats up, and the freshest active one gets the
              accent bar. Location of the recents block is unchanged.
            </Note>
            <Note n={3}>
              <b className="text-foreground">Today nested underneath.</b> Expand a project to see
              today's chats and active looms inline — no context switch to find the thing you
              touched five minutes ago.
            </Note>
          </ol>
        </div>
      )}
    </DemoStage>
  );
}
